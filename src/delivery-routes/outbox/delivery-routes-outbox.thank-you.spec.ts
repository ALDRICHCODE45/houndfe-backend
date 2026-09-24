/**
 * SPEC: DTE-5b.claim+dispatch — dedicated delivery-routes outbox.
 *
 * ONE atomic unit: the dedicated poller claim widens from equality to
 * BOTH `delivery.next_stop.notify` and `delivery.thank_you.notify`, and
 * the dispatcher becomes type-aware in the same commit. Pins retained
 * claim predicates (`PENDING`/due/unlocked, `FOR UPDATE SKIP LOCKED`,
 * lease UPDATE; the generic `NOT IN` exclusion stays in
 * `outbox-poller.service.spec.ts`); unchanged next-stop routing;
 * fail-closed thank-you routing (ids-only, tenant/route verified, stable
 * tenant:sale:stop id); unroutable and rejected rows staying PENDING with
 * retry/backoff (FAILED on exhaustion); lockToken CAS terminal writes.
 * In-memory Prisma/Inngest stubs only — no live DB or provider.
 */
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  DELIVERY_THANK_YOU_NOTIFY_EVENT,
  DELIVERY_THANK_YOU_OUTBOX_TYPE,
} from '../inngest/delivery-thank-you.event';
import {
  DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
  DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
} from './delivery-route-outbox.types';
import { DeliveryRoutesOutboxDispatcher } from './delivery-routes-outbox.dispatcher';
import { DeliveryRoutesOutboxPoller } from './delivery-routes-outbox.poller';

const { PENDING, PUBLISHED, FAILED } = OutboxEventStatus;

const IDS = {
  tenantId: 'tenant-1',
  saleId: 'sale-1',
  routeId: 'route-1',
  stopId: 'stop-1',
} as const;

const ROW_BASE = {
  status: PENDING,
  retryCount: 0,
  nextAttemptAt: new Date(),
  lastError: null,
  lockedUntil: new Date(),
  createdAt: new Date(),
  publishedAt: null,
};

const NEXT_STOP_PAYLOAD = {
  tenantId: 'tenant-1',
  routeId: 'route-1',
  currentStopId: 'stop-0',
  nextStopId: 'stop-1',
  nextSaleId: 'sale-1',
  nextCustomerName: 'Ada',
  nextAddressLabel: 'Calle 1',
  nextCustomerEmail: 'ada@example.com',
  idempotencyKey: 'tenant-1:stop-0',
  occurredAt: '2026-09-01T00:00:00.000Z',
};

function nextStopRow(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    ...ROW_BASE,
    id: 'evt-next-stop',
    tenantId: 'tenant-1',
    aggregateType: DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
    aggregateId: 'route-1',
    eventType: DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
    payload: NEXT_STOP_PAYLOAD,
    lockToken: 'lock-next-stop',
    ...overrides,
  };
}

function thankYouRow(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    ...ROW_BASE,
    id: 'evt-thank-you',
    tenantId: IDS.tenantId,
    aggregateType: DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE,
    aggregateId: IDS.routeId,
    eventType: DELIVERY_THANK_YOU_OUTBOX_TYPE,
    payload: { ...IDS },
    lockToken: 'lock-thank-you',
    ...overrides,
  };
}

interface UpdateArgs {
  where: { id: string; lockToken: string | null };
  data: {
    status: OutboxEventStatus;
    retryCount?: number;
    lastError?: string | null;
    nextAttemptAt?: Date;
    publishedAt?: Date;
    lockToken: null;
    lockedUntil: null;
  };
}

function inngestStub() {
  const send = jest
    .fn<Promise<{ ids: string[] }>, [string, unknown, string]>()
    .mockResolvedValue({ ids: ['inngest-1'] });
  return { inngestService: { send }, send };
}

function prismaStub() {
  const updateMany = jest
    .fn<Promise<{ count: number }>, [UpdateArgs]>()
    .mockResolvedValue({ count: 1 });
  return { prisma: { outboxEvent: { updateMany } }, updateMany };
}

function buildDispatcher(
  inngestService: unknown,
  prisma: unknown,
  maxRetries = 5,
) {
  return new DeliveryRoutesOutboxDispatcher(
    inngestService as never,
    prisma as never,
    maxRetries,
  );
}

/** Fake poller Prisma: the claim SELECT returns row ids, the UPDATE the rows. */
function pollerPrisma(rows: DispatchableOutboxEvent[]) {
  const sqlCalls: string[] = [];
  const prisma = {
    $transaction: (work: (tx: unknown) => Promise<unknown>) =>
      work({
        $queryRawUnsafe: jest
          .fn<Promise<unknown>, [string, ...unknown[]]>()
          .mockImplementation((sql: string) => {
            sqlCalls.push(sql);
            if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
              return Promise.resolve(rows.map((row) => ({ id: row.id })));
            }
            if (/UPDATE\s+outbox_events/i.test(sql)) {
              return Promise.resolve(rows);
            }
            return Promise.resolve([]);
          }),
      }),
  };
  return { prisma, sqlCalls };
}

function buildPoller(prisma: unknown, dispatcher: unknown) {
  return new DeliveryRoutesOutboxPoller(
    prisma as never,
    1000,
    50,
    30000,
    dispatcher as never,
  );
}

describe('DeliveryRoutesOutboxPoller claim (DTE-5b)', () => {
  it('claims ONLY the two delivery-routes types with retained predicates and hands BOTH rows to the dispatcher', async () => {
    const rows = [nextStopRow(), thankYouRow()];
    const { prisma, sqlCalls } = pollerPrisma(rows);
    const dispatched: DispatchableOutboxEvent[] = [];
    const dispatcher = {
      dispatch: jest.fn((event: DispatchableOutboxEvent) => {
        dispatched.push(event);
        return Promise.resolve();
      }),
    };

    await buildPoller(prisma, dispatcher).poll();

    const sql =
      sqlCalls.find((s) => /SELECT\s+id\s+FROM\s+outbox_events/i.test(s)) ?? '';
    // Widened from equality to a two-type IN; both the pinned SQL literal
    // and the interpolated constants are asserted so a rename breaks it.
    expect(sql).toContain(
      `"eventType" IN ('delivery.next_stop.notify', 'delivery.thank_you.notify')`,
    );
    expect(sql).toContain(
      `'${DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE}', '${DELIVERY_THANK_YOU_OUTBOX_TYPE}'`,
    );
    expect(sql).toContain(`status = 'PENDING'`);
    expect(sql).toContain(`"nextAttemptAt" <= NOW()`);
    expect(sql).toContain(`"lockedUntil" IS NULL OR "lockedUntil" < NOW()`);
    expect(sql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    expect(sql).not.toContain(`"eventType" = 'delivery.next_stop.notify'`);
    // The dedicated claim never carries the generic NOT IN exclusion.
    expect(sql).not.toContain('NOT IN');

    const update =
      sqlCalls.find((s) => /UPDATE\s+outbox_events/i.test(s)) ?? '';
    expect(update).toContain('SET "lockToken" = $1');
    expect(update).toContain(
      `"lockedUntil" = NOW() + ($2 * INTERVAL '1 second')`,
    );

    expect(dispatched).toEqual(rows);
    expect(dispatched.map((row) => row.eventType)).toEqual([
      DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE,
      DELIVERY_THANK_YOU_OUTBOX_TYPE,
    ]);
  });
});

describe('DeliveryRoutesOutboxDispatcher routing (DTE-5b)', () => {
  it('next-stop route is unchanged: original event name, verbatim payload, committed key', async () => {
    const { inngestService, send } = inngestStub();
    const { prisma, updateMany } = prismaStub();
    const row = nextStopRow();

    await buildDispatcher(inngestService, prisma).dispatch(row);

    expect(send).toHaveBeenCalledWith(
      'delivery/next-stop.notify',
      row.payload,
      'tenant-1:stop-0',
    );
    expect(send.mock.calls[0][1]).toBe(row.payload);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: row.id, lockToken: row.lockToken });
    expect(arg.data.status).toBe(PUBLISHED);
  });

  it('thank-you route: committed event, ids-only PII-stripped payload, stable id, lockToken CAS', async () => {
    const { inngestService, send } = inngestStub();
    const { prisma, updateMany } = prismaStub();
    const dispatcher = buildDispatcher(inngestService, prisma);

    await dispatcher.dispatch(thankYouRow());
    expect(send).toHaveBeenCalledWith(
      DELIVERY_THANK_YOU_NOTIFY_EVENT,
      IDS,
      'tenant-1:sale-1:stop-1',
    );
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      id: 'evt-thank-you',
      lockToken: 'lock-thank-you',
    });
    expect(arg.data.status).toBe(PUBLISHED);
    expect(arg.data.publishedAt).toBeInstanceOf(Date);

    // Extra untrusted fields on the row payload must never reach Inngest.
    await dispatcher.dispatch(
      thankYouRow({
        payload: {
          ...IDS,
          customerEmail: 'attacker@example.com',
          customerName: 'Ada Lovelace',
          amountCents: 25000,
          addresses: ['Calle 1'],
          idempotencyKey: 'seed',
        },
      }),
    );
    const data = send.mock.calls[1][1] as Record<string, unknown>;
    expect(data).toEqual(IDS);
    expect(Object.keys(data)).toHaveLength(4);
    expect(data).not.toHaveProperty('customerEmail');
    expect(data).not.toHaveProperty('customerName');
  });

  it('replays the exact stable key while a different stop stays distinct', async () => {
    const { inngestService, send } = inngestStub();
    const { prisma } = prismaStub();
    const dispatcher = buildDispatcher(inngestService, prisma);

    await dispatcher.dispatch(thankYouRow());
    await dispatcher.dispatch(
      thankYouRow({ id: 'evt-replay', lockToken: 'lock-replay' }),
    );
    await dispatcher.dispatch(
      thankYouRow({
        id: 'evt-stop-2',
        lockToken: 'lock-stop-2',
        payload: { ...IDS, stopId: 'stop-2' },
      }),
    );

    expect(send.mock.calls[0][2]).toBe('tenant-1:sale-1:stop-1');
    expect(send.mock.calls[1][2]).toBe(send.mock.calls[0][2]);
    expect(send.mock.calls[2][2]).toBe('tenant-1:sale-1:stop-2');
    expect(send.mock.calls[2][2]).not.toBe(send.mock.calls[0][2]);
  });
});

describe('DeliveryRoutesOutboxDispatcher fail-closed refusals (DTE-5b)', () => {
  const withPayload = (payload: DispatchableOutboxEvent['payload']) =>
    thankYouRow({ payload });
  const unroutable: Array<[string, DispatchableOutboxEvent]> = [
    [
      'malformed thank-you payload',
      withPayload({
        tenantId: IDS.tenantId,
        saleId: IDS.saleId,
        routeId: IDS.routeId,
      }),
    ],
    ['non-object payload', withPayload(['nope'])],
    ['blank stopId', withPayload({ ...IDS, stopId: '   ' })],
    ['foreign tenant', withPayload({ ...IDS, tenantId: 'tenant-2' })],
    ['route mismatch', withPayload({ ...IDS, routeId: 'route-2' })],
    ['wrong aggregateType', thankYouRow({ aggregateType: 'Sale' })],
    [
      'unsupported eventType',
      thankYouRow({ eventType: 'delivery.unknown.notify' }),
    ],
  ];

  it.each(unroutable)(
    'NEVER sends and keeps PENDING with bumped retry: %s',
    async (_label, row) => {
      const { inngestService, send } = inngestStub();
      const { prisma, updateMany } = prismaStub();

      await buildDispatcher(inngestService, prisma).dispatch(row);

      expect(send).not.toHaveBeenCalled();
      const arg = updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: row.id, lockToken: row.lockToken });
      expect(arg.data.status).toBe(PENDING);
      expect(arg.data.retryCount).toBe(row.retryCount + 1);
      expect(arg.data.lastError).toEqual(expect.any(String));
      expect(arg.data.nextAttemptAt).toBeInstanceOf(Date);
    },
  );

  it('an unroutable row dead-letters to FAILED at maxRetries', async () => {
    const { inngestService, send } = inngestStub();
    const { prisma, updateMany } = prismaStub();

    await buildDispatcher(inngestService, prisma, 5).dispatch(
      thankYouRow({ retryCount: 4, payload: { nope: true } }),
    );

    expect(send).not.toHaveBeenCalled();
    const arg = updateMany.mock.calls[0][0];
    expect(arg.data.status).toBe(FAILED);
    expect(arg.data.retryCount).toBe(5);
  });

  it('a rejected send leaves PENDING and increments retry — never fire-and-forget', async () => {
    const { inngestService, send } = inngestStub();
    send.mockRejectedValueOnce(new Error('Inngest down'));
    const { prisma, updateMany } = prismaStub();
    const row = thankYouRow();

    await expect(
      buildDispatcher(inngestService, prisma).dispatch(row),
    ).resolves.toBeUndefined();

    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: row.id, lockToken: row.lockToken });
    expect(arg.data.status).toBe(PENDING);
    expect(arg.data.retryCount).toBe(1);
    expect(arg.data.lastError).toMatch(/Inngest down/);
  });
});
