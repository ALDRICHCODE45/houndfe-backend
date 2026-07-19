/**
 * HrTimeOffOutboxPoller tests — v2 backlog coverage gap closed.
 *
 * The dedicated poller claims ONLY `hr.timeoff.requested` PENDING rows
 * from the outbox table — disjoint from the generic
 * `OutboxPollerService` (which excludes that `eventType`) and from the
 * low-stock poller. Claim uses `FOR UPDATE SKIP LOCKED` for concurrency
 * safety + `lockToken`/`lockedUntil` so concurrent pollers can't
 * double-claim a row.
 *
 * The `@Interval` decorator is owned by the framework; this spec
 * exercises the underlying `claimBatch()`/`poll()` public seams
 * directly with a fake Prisma transaction so it is both deterministic
 * and CI-fast — the SAME mocking style as the sibling
 * `low-stock-outbox.poller.spec.ts` (mocks `$transaction` +
 * `$queryRawUnsafe`).
 *
 * Coverage:
 *   - claimBatch() SELECT carries the EXCLUSIVE predicate
 *     `"eventType" = 'hr.timeoff.requested'` + status/nextAttemptAt/
 *     lockedUntil clauses + FOR UPDATE SKIP LOCKED.
 *   - empty PENDING batch → [] and dispatcher NOT called.
 *   - claimed rows → each forwarded to dispatcher.dispatch(event).
 *   - per-row try/catch: one throwing dispatch does not reject poll()
 *     nor abort the remaining rows.
 *   - intervalMs throttle: a second poll() within intervalMs is a no-op.
 */
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  HR_TIME_OFF_OUTBOX_POLLER_BATCH_SIZE,
  HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS,
  HR_TIME_OFF_OUTBOX_POLLER_LOCK_MS,
  HrTimeOffOutboxPoller,
} from './hr-time-off-outbox.poller';

function buildClaimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'EmployeeTimeOff',
    aggregateId: 'to-1',
    eventType: 'hr.timeoff.requested',
    payload: {
      tenantId: 'tenant-1',
      timeOffId: 'to-1',
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

describe('HrTimeOffOutboxPoller', () => {
  it('claim SELECT targets ONLY status=PENDING AND eventType=hr.timeoff.requested (DISJOINT from the generic + low-stock pollers)', async () => {
    const capturedCalls: string[] = [];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
            capturedCalls.push(sql);
            return Promise.resolve([]);
          }),
        };
        return work(tx);
      },
    };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      { dispatch: jest.fn() } as never,
    );

    await (
      service as unknown as { claimBatch: () => Promise<unknown> }
    ).claimBatch();

    const claimSql =
      capturedCalls.find((c) =>
        /SELECT\s+id\s+FROM\s+outbox_events/i.test(c),
      ) ?? '';
    expect(claimSql).toContain(`status = 'PENDING'`);
    // The EXCLUSIVE predicate — this poller claims ONLY HR-time-off rows.
    expect(claimSql).toContain(`"eventType" = 'hr.timeoff.requested'`);
    expect(claimSql).toContain(`"nextAttemptAt" <= NOW()`);
    // lock-decay: lockedUntil null OR expired.
    expect(claimSql).toContain(
      `"lockedUntil" IS NULL OR "lockedUntil" < NOW()`,
    );
    expect(claimSql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    // The dedicated poller MUST NOT carry the NEGATIVE predicate
    // (that belongs to the generic poller's exclusion).
    expect(claimSql).not.toContain(`"eventType" <> 'hr.timeoff.requested'`);
  });

  it('after claim, sets lockToken + lockedUntil on the claimed rows (UPDATE ... RETURNING)', async () => {
    const capturedCalls: string[] = [];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
            capturedCalls.push(sql);
            if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
              return Promise.resolve([{ id: 'evt-1' }]);
            }
            if (/UPDATE\s+outbox_events/i.test(sql)) {
              return Promise.resolve([buildClaimed()]);
            }
            return Promise.resolve([]);
          }),
        };
        return work(tx);
      },
    };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await (
      service as unknown as { claimBatch: () => Promise<unknown> }
    ).claimBatch();

    const updateSql =
      capturedCalls.find((c) => /UPDATE\s+outbox_events/i.test(c)) ?? '';
    expect(updateSql).toContain('SET "lockToken" = $1');
    expect(updateSql).toContain(
      '"lockedUntil" = NOW() + ($2 * INTERVAL \'1 second\')',
    );
  });

  it('empty PENDING batch → claimBatch() returns [] and poll() does NOT call the dispatcher', async () => {
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        };
        return work(tx);
      },
    };
    const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      dispatcher as never,
    );

    const claimed = await (
      service as unknown as { claimBatch: () => Promise<unknown[]> }
    ).claimBatch();
    expect(claimed).toEqual([]);

    await (service as unknown as { poll: () => Promise<void> }).poll();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('hands each claimed row to the dedicated dispatcher (poll() forwards every row)', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-1', aggregateId: 'to-1', lockToken: 'lock-1' }),
      buildClaimed({ id: 'evt-2', aggregateId: 'to-2', lockToken: 'lock-2' }),
    ];

    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
            if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
              return Promise.resolve(claimed.map((c) => ({ id: c.id })));
            }
            if (/UPDATE\s+outbox_events/i.test(sql)) {
              return Promise.resolve(claimed);
            }
            return Promise.resolve([]);
          }),
        };
        return work(tx);
      },
    };

    const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      dispatcher as never,
    );

    await (service as unknown as { poll: () => Promise<void> }).poll();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
  });

  // ─── Per-row try/catch (outer fence, mirrors low-stock R4) ────────
  // A single throwing dispatcher (poison row, downstream outage that
  // escaped dispatch's own try/catch) must NOT abort the rest of the
  // batch NOR reject out of poll() — an unhandled rejection inside
  // @Interval would leave up to batchSize claimed rows locked for
  // lockMs=60s. Each dispatch is fenced in its own try/catch.
  it('when dispatcher.dispatch() rejects for one row, the remaining rows still dispatch and poll() resolves (no rejected interval tick)', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-A', aggregateId: 'to-A', lockToken: 'lock-A' }),
      buildClaimed({ id: 'evt-B', aggregateId: 'to-B', lockToken: 'lock-B' }),
      buildClaimed({ id: 'evt-C', aggregateId: 'to-C', lockToken: 'lock-C' }),
    ];

    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
            if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
              return Promise.resolve(claimed.map((c) => ({ id: c.id })));
            }
            if (/UPDATE\s+outbox_events/i.test(sql)) {
              return Promise.resolve(claimed);
            }
            return Promise.resolve([]);
          }),
        };
        return work(tx);
      },
    };

    // The MIDDLE row rejects — the others MUST still be dispatched and
    // poll() MUST resolve cleanly (no unhandled rejection).
    const dispatcher = {
      dispatch: jest
        .fn()
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          throw new Error('dispatcher-BOOM — must NOT abort batch');
        })
        .mockImplementationOnce(async () => undefined),
    };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000,
      25,
      60000,
      dispatcher as never,
    );

    await expect(
      (service as unknown as { poll: () => Promise<void> }).poll(),
    ).resolves.toBeUndefined();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(3, claimed[2]);
  });

  // ─── intervalMs throttle ──────────────────────────────────────────
  // The @Interval decorator fires every DECORATOR_TICK_MS (1s), but the
  // poller self-throttles to `intervalMs` via `lastPollAt`. A second
  // poll() inside the window must be a no-op — NO claim transaction.
  it('throttles: a second poll() within intervalMs does NOT claim again', async () => {
    let transactionCount = 0;
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        const tx = {
          $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        };
        return work(tx);
      },
    };
    const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const service = new HrTimeOffOutboxPoller(
      prisma as never,
      5000, // intervalMs — well above the two synchronous poll() calls
      25,
      60000,
      dispatcher as never,
    );

    // First poll runs the claim (lastPollAt starts at 0 → elapsed huge).
    await (service as unknown as { poll: () => Promise<void> }).poll();
    // Second poll immediately after → within intervalMs → no-op.
    await (service as unknown as { poll: () => Promise<void> }).poll();

    expect(transactionCount).toBe(1);
  });

  it('exports the documented injection tokens for interval/batch/lock overrides', () => {
    expect(typeof HR_TIME_OFF_OUTBOX_POLLER_INTERVAL_MS).toBe('symbol');
    expect(typeof HR_TIME_OFF_OUTBOX_POLLER_BATCH_SIZE).toBe('symbol');
    expect(typeof HR_TIME_OFF_OUTBOX_POLLER_LOCK_MS).toBe('symbol');
  });
});
