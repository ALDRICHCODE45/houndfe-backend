/**
 * HrTimeOffOutboxDispatcher tests (Slice 5 + lockToken CAS hardening).
 *
 * Mirrors the LowStockOutboxDispatcher contract but for the HR time-off
 * pipeline (eventType='hr.timeoff.requested'). The dispatcher receives
 * a claimed `OutboxEvent` row from `HrTimeOffOutboxPoller` and AWAITs
 * `InngestService.send(...)`. The await is load-bearing: a post-commit
 * rejection means the row stays PENDING and the dedicated poller
 * retries it. Marking `PUBLISHED` happens ONLY on resolve.
 *
 * Idempotency seed is `${tenantId}:${timeOffId}` per Design D1 — the
 * same shape the gated `request()` already encodes via
 * `aggregateId = timeOffId`. A poller replay of the SAME row collapses
 * to ONE Inngest event.
 *
 * No enrichment: the outbox payload is self-contained per Design D3
 * (unlike low-stock which enriches from product/variant/category
 * reads). The dispatcher forwards `event.payload` directly to
 * `InngestService.send('hr/timeoff.requested', payload, idem)`.
 *
 * lockToken CAS hardening: the terminal writes (`markPublished`,
 * `markRetry`) match on BOTH id AND lockToken via
 * `updateMany({ where: { id, lockToken }, ... })`. If a worker's 60s
 * lease expires and another poll re-claims the SAME row, the stale
 * worker's terminal write matches ZERO rows (`count === 0`) and is
 * skipped — it can no longer clobber the new owner's claim/state.
 * `.update()` requires a UNIQUE where and cannot carry the non-unique
 * lockToken; `.updateMany()` can, and returns `{ count }`.
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice 5 +
 * time-off-notifications 'Delivery Is Durable' + 'Idempotency Key
 * Deduplicates Retries'.
 */
import { Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { HrTimeOffOutboxDispatcher } from './hr-time-off-outbox.dispatcher';

function buildClaimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-hr-1',
    tenantId: 'tenant-1',
    aggregateType: 'EmployeeTimeOff',
    aggregateId: 'timeoff-1',
    eventType: 'hr.timeoff.requested',
    payload: {
      tenantId: 'tenant-1',
      timeOffId: 'timeoff-1',
      employeeId: 'emp-1',
      type: 'VACATION',
      startDate: '2026-07-01T00:00:00.000Z',
      endDate: '2026-07-05T00:00:00.000Z',
      employeeName: 'Ada Lovelace',
      requestedByUserId: 'user-1',
    },
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

describe('HrTimeOffOutboxDispatcher (Slice 5)', () => {
  // ─── Regression (lockToken CAS guard) ─────────────────────────────
  // The terminal write MUST match on BOTH id AND lockToken so a stale
  // worker (whose lease expired and whose row was re-claimed) cannot
  // clobber the new claim. Prisma `.update()` requires a UNIQUE where
  // and cannot carry the non-unique lockToken — so the dispatcher must
  // use `.updateMany({ where: { id, lockToken }, ... })`, which returns
  // `{ count }`. This test is RED while the code still calls `.update`.
  it('marks PUBLISHED via updateMany with a lockToken compare-and-swap (where: { id, lockToken })', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      outboxEvent: {
        // Present but MUST NOT be used — the guard requires updateMany.
        update: jest.fn().mockResolvedValue({ id: 'evt-hr-1' }),
        updateMany: updateManyMock,
      },
    };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await dispatcher.dispatch(
      buildClaimed({ id: 'evt-cas', lockToken: 'lock-cas' }),
    );

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0][0] as {
      where: { id: string; lockToken: string };
      data: { status: OutboxEventStatus };
    };
    expect(arg.where).toEqual({ id: 'evt-cas', lockToken: 'lock-cas' });
    expect(arg.data.status).toBe(OutboxEventStatus.PUBLISHED);
    // The plain `.update` (no lock re-check) must NOT be the write path.
    expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
  });

  it('AWAITS InngestService.send with event name "hr/timeoff.requested" before marking PUBLISHED', async () => {
    const callOrder: string[] = [];
    const inngestService = {
      send: jest.fn(() => {
        callOrder.push('send.resolve');
        return Promise.resolve({ ids: ['evt-id'] });
      }),
    };
    const updateManyMock = jest.fn((args: unknown) => {
      callOrder.push(
        `updateMany:${(args as { data: { status: string } }).data.status}`,
      );
      return Promise.resolve({ count: 1 });
    });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await dispatcher.dispatch(buildClaimed());

    // Resolve ORDER: send → updateMany(PUBLISHED). A regression that
    // marks PUBLISHED before awaiting send would lose a rejected event.
    expect(callOrder).toEqual(['send.resolve', 'updateMany:PUBLISHED']);
    expect(inngestService.send.mock.calls[0][0]).toBe('hr/timeoff.requested');
  });

  it('sends with idempotency key `${tenantId}:${timeOffId}` (= aggregateId)', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const prisma = {
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await dispatcher.dispatch(buildClaimed({ id: 'evt-hr-2' }));

    expect(inngestService.send).toHaveBeenCalledTimes(1);
    const call = inngestService.send.mock.calls[0] as unknown[];
    // send(name, payload, idempotencyKey)
    expect(call[0]).toBe('hr/timeoff.requested');
    const payload = call[1] as { timeOffId: string };
    expect(payload.timeOffId).toBe('timeoff-1');
    const idemKey = call[2] as string;
    expect(idemKey).toBe('tenant-1:timeoff-1');
  });

  it('replay: dispatching the same row twice uses the SAME idempotency key (collapses to one Inngest event)', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const prisma = {
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    const claimed = buildClaimed({ id: 'evt-replay' });
    await dispatcher.dispatch(claimed);
    const replayed = { ...claimed, status: OutboxEventStatus.PENDING };
    await dispatcher.dispatch(replayed);

    const keys = inngestService.send.mock.calls.map(
      (c: unknown[]) => c[2] as string,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('tenant-1:timeoff-1');
    expect(keys[0]).toBe(keys[1]);
  });

  it('marks PUBLISHED on resolve (clear lockToken/lockedUntil, stamp publishedAt)', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await dispatcher.dispatch(buildClaimed({ id: 'evt-published' }));

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0][0] as {
      where: { id: string; lockToken: string };
      data: {
        status: OutboxEventStatus;
        publishedAt: Date;
        retryCount: number;
        lastError: null;
        lockToken: null;
        lockedUntil: null;
      };
    };
    expect(arg.where.id).toBe('evt-published');
    expect(arg.data.status).toBe(OutboxEventStatus.PUBLISHED);
    expect(arg.data.lastError).toBeNull();
    expect(arg.data.lockToken).toBeNull();
    expect(arg.data.lockedUntil).toBeNull();
    expect(arg.data.publishedAt).toBeInstanceOf(Date);
  });

  it('on reject under maxRetries: marks PENDING + bumps retryCount + bumps nextAttemptAt + records lastError (CAS where)', async () => {
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('Inngest down')),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    const before = Date.now();
    await dispatcher.dispatch(buildClaimed({ retryCount: 1 }));

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0][0] as {
      where: { id: string; lockToken: string };
      data: {
        status: OutboxEventStatus;
        retryCount: number;
        lastError: string;
        nextAttemptAt: Date;
        lockToken: null;
        lockedUntil: null;
      };
    };
    // CAS where — the retry write is also lock-guarded.
    expect(arg.where).toEqual({ id: 'evt-hr-1', lockToken: 'lock-1' });
    expect(arg.data.status).toBe(OutboxEventStatus.PENDING);
    expect(arg.data.retryCount).toBe(2);
    expect(arg.data.lastError).toMatch(/Inngest down/);
    expect(arg.data.nextAttemptAt).toBeInstanceOf(Date);
    // Backoff at retryCount=2 → BACKOFF_TABLE_MS[1] = 5_000ms ±10%.
    const delayMs = arg.data.nextAttemptAt.getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(2_000);
    expect(delayMs).toBeLessThanOrEqual(6_000);
    expect(arg.data.lockToken).toBeNull();
    expect(arg.data.lockedUntil).toBeNull();
  });

  it('on reject at maxRetries: marks FAILED + logs error', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('dead-letter')),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    // retryCount=4 → next=5 === maxRetries ⇒ exhausted.
    await dispatcher.dispatch(buildClaimed({ retryCount: 4 }));

    const arg = updateManyMock.mock.calls[0][0] as {
      data: { status: OutboxEventStatus; retryCount: number };
    };
    expect(arg.data.status).toBe(OutboxEventStatus.FAILED);
    expect(arg.data.retryCount).toBe(5);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('does NOT re-throw send rejections (dispatch() resolves cleanly)', async () => {
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const prisma = {
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await expect(dispatcher.dispatch(buildClaimed())).resolves.toBeUndefined();
  });

  it('does NOT enrich the payload — sends event.payload verbatim (Design D3)', async () => {
    // The HR outbox payload is self-contained: timeOffId, employeeId,
    // type, dates, employeeName, requestedByUserId all live in the
    // payload at write-time (request() side). The dispatcher does NOT
    // re-read product/variant/category/etc. (unlike low-stock which
    // enriches from tenant-scoped Prisma reads).
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const prisma = {
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    const claimed = buildClaimed();
    await dispatcher.dispatch(claimed);

    const sentPayload = (inngestService.send.mock.calls[0] as unknown[])[1];
    // Identity equality with the claimed row's payload (no field
    // mutation, no re-read).
    expect(sentPayload).toBe(claimed.payload);
  });

  // ─── CAS guard: lock lost/expired (count === 0) ───────────────────
  // When the terminal write matches ZERO rows, another worker has
  // re-claimed the row (this worker's lease expired). The slow worker
  // must NOT throw and must NOT retry — it logs at debug and returns,
  // leaving the row's state entirely to the new owner.
  it('when updateMany matches no row on markPublished (count=0 — lock lost), dispatch() does NOT throw and logs at debug', async () => {
    const debugSpy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id'] }),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await expect(
      dispatcher.dispatch(buildClaimed({ id: 'evt-lost', lockToken: 'stale' })),
    ).resolves.toBeUndefined();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it('when updateMany matches no row on markRetry (count=0 — lock lost), dispatch() does NOT throw', async () => {
    const debugSpy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('Inngest down')),
    };
    const updateManyMock = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { outboxEvent: { updateMany: updateManyMock } };

    const dispatcher = new HrTimeOffOutboxDispatcher(
      inngestService as never,
      prisma as never,
      5,
    );

    await expect(
      dispatcher.dispatch(buildClaimed({ retryCount: 1 })),
    ).resolves.toBeUndefined();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalled();

    debugSpy.mockRestore();
  });
});
