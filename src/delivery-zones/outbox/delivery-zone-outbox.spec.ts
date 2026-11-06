/**
 * shipping-zones / T1 (S3) — dedicated outbox poller + dispatcher for
 * `delivery_zone.validation.requested` (mirrors the HR time-off pair).
 */
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { DeliveryZoneOutboxDispatcher } from './delivery-zone-outbox.dispatcher';
import { DeliveryZoneOutboxPoller } from './delivery-zone-outbox.poller';

function claimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'DeliveryZoneValidation',
    aggregateId: 'validation-1',
    eventType: 'delivery_zone.validation.requested',
    payload: { tenantId: 'tenant-1', validationId: 'validation-1' },
    status: OutboxEventStatus.PENDING,
    retryCount: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    lockToken: 'lock-1',
    lockedUntil: new Date(),
    createdAt: new Date(),
    publishedAt: null,
    ...overrides,
  };
}

describe('DeliveryZoneOutboxPoller', () => {
  it('claims ONLY pending delivery_zone.validation.requested rows with SKIP LOCKED', async () => {
    const sql: string[] = [];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRawUnsafe: jest.fn((query: string) => {
            sql.push(query);
            return Promise.resolve([]);
          }),
        }),
    };
    const poller = new DeliveryZoneOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      { dispatch: jest.fn() } as never,
    );
    await poller.claimBatch();
    expect(sql[0]).toContain(`status = 'PENDING'`);
    expect(sql[0]).toContain(
      `"eventType" = 'delivery_zone.validation.requested'`,
    );
    expect(sql[0]).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it('keeps dispatching the batch when one row throws', async () => {
    const rows = [claimed({ id: 'a' }), claimed({ id: 'b' })];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRawUnsafe: jest.fn((query: string) =>
            Promise.resolve(
              /^\s*SELECT/i.test(query) ? rows.map(({ id }) => ({ id })) : rows,
            ),
          ),
        }),
    };
    const dispatcher = {
      dispatch: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
    };
    const poller = new DeliveryZoneOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      dispatcher as never,
    );
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('DeliveryZoneOutboxDispatcher', () => {
  it('awaits the Inngest send with a tenant:validation idempotency key, then marks PUBLISHED via lockToken CAS', async () => {
    const order: string[] = [];
    const inngest = {
      send: jest.fn(() => {
        order.push('send');
        return Promise.resolve({ ids: ['x'] });
      }),
    };
    const updateMany = jest.fn((args: { data: { status: string } }) => {
      order.push(`update:${args.data.status}`);
      return Promise.resolve({ count: 1 });
    });
    const dispatcher = new DeliveryZoneOutboxDispatcher(
      inngest as never,
      { outboxEvent: { updateMany } } as never,
      5,
    );
    const event = claimed();
    await dispatcher.dispatch(event);
    expect(inngest.send).toHaveBeenCalledWith(
      'delivery-zones/validation.requested',
      event.payload,
      'tenant-1:validation-1',
    );
    expect(order).toEqual(['send', 'update:PUBLISHED']);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'evt-1', lockToken: 'lock-1' },
    });
  });

  it('schedules a retry on rejection and FAILED at max retries', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const dispatcher = new DeliveryZoneOutboxDispatcher(
      { send: jest.fn().mockRejectedValue(new Error('down')) } as never,
      { outboxEvent: { updateMany } } as never,
      5,
    );
    await dispatcher.dispatch(claimed({ retryCount: 1 }));
    await dispatcher.dispatch(claimed({ retryCount: 4 }));
    const statuses = updateMany.mock.calls.map(
      (call: [{ data: { status: string; retryCount: number } }]) => [
        call[0].data.status,
        call[0].data.retryCount,
      ],
    );
    expect(statuses).toEqual([
      ['PENDING', 2],
      ['FAILED', 5],
    ]);
  });
});
