/**
 * Slice F.4 — LowStockOutboxPoller tests (RED → GREEN).
 *
 * The dedicated poller claims ONLY `stock.low.detected` PENDING
 * rows from the outbox table — disjoint from the generic
 * `OutboxPollerService`, which excludes that `eventType` (F.3).
 * Claim uses `FOR UPDATE SKIP LOCKED` for concurrency safety +
 * `lockToken`/`lockedUntil` so concurrent pollers can't double-claim
 * a row.
 *
 * The `@Interval` decorator is owned by the framework; this spec
 * exercises the underlying `claimBatch()` (or equivalent public
 * seam) directly with a fake Prisma transaction so it's both
 * deterministic and CI-fast — same pattern as
 * `outbox-poller.service.spec.ts` (the generic poller spec).
 *
 * Spec coverage:
 *   - design.md "Durable dispatch flow (finding #10)" + the
 *     dedicated poller/dedicated dispatcher paragraphs.
 *   - Slice F.4 task: "claims ONLY
 *     status='PENDING' AND eventType='stock.low.detected' AND
 *     nextAttemptAt <= NOW() + lockedUntil; SKIP LOCKED + lockToken".
 */
import { OutboxEventStatus } from '@prisma/client';
import {
  LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE,
  LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS,
  LOW_STOCK_OUTBOX_POLLER_LOCK_MS,
  LowStockOutboxPoller,
} from './low-stock-outbox.poller';

describe('LowStockOutboxPoller (F.4)', () => {
  it('claim SELECT targets ONLY status=PENDING AND eventType=stock.low.detected (DISJOINT from the generic poller)', async () => {
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

    const service = new LowStockOutboxPoller(
      prisma as never,
      1000,
      50,
      30000,
      // F.5 dispatcher hand-off
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
    expect(claimSql).toContain(`"eventType" = 'stock.low.detected'`);
    expect(claimSql).toContain(`"nextAttemptAt" <= NOW()`);
    // lock-decay: lockedUntil null OR expired
    expect(claimSql).toContain(
      `"lockedUntil" IS NULL OR "lockedUntil" < NOW()`,
    );
    expect(claimSql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    // The dedicated poller MUST NOT have the NEGATIVE predicate
    // (that's the generic poller's job — see F.3).
    expect(claimSql).not.toContain(`"eventType" <> 'stock.low.detected'`);
  });

  it('after claim, sets lockToken + lockedUntil on the claimed rows (UPDATE ... RETURNING)', async () => {
    const capturedCalls: string[] = [];
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
            capturedCalls.push(sql);
            // First call: claim SELECT — return one matching id.
            if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
              return Promise.resolve([{ id: 'evt-1' }]);
            }
            // Second call: lock UPDATE — return one claimed row.
            if (/UPDATE\s+outbox_events/i.test(sql)) {
              return Promise.resolve([
                {
                  id: 'evt-1',
                  tenantId: 'tenant-1',
                  aggregateType: 'StockAlert',
                  aggregateId: 'product-1:__PRODUCT__',
                  eventType: 'stock.low.detected',
                  payload: {
                    tenantId: 'tenant-1',
                    productId: 'product-1',
                    alertEpoch: 1,
                  },
                  status: OutboxEventStatus.PENDING,
                  retryCount: 0,
                  nextAttemptAt: new Date(),
                  lastError: null,
                  lockToken: 'lock-1',
                  lockedUntil: new Date(),
                  createdAt: new Date(),
                  publishedAt: null,
                },
              ]);
            }
            return Promise.resolve([]);
          }),
        };
        return work(tx);
      },
    };

    const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };

    const service = new LowStockOutboxPoller(
      prisma as never,
      1000,
      50,
      30000,
      dispatcher as never,
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

  it('hands each claimed row to the dedicated dispatcher (F.5 hand-off)', async () => {
    const claimed = [
      {
        id: 'evt-1',
        tenantId: 'tenant-1',
        aggregateType: 'StockAlert',
        aggregateId: 'product-1:__PRODUCT__',
        eventType: 'stock.low.detected',
        payload: { tenantId: 'tenant-1', productId: 'product-1' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-1',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
      {
        id: 'evt-2',
        tenantId: 'tenant-1',
        aggregateType: 'StockAlert',
        aggregateId: 'product-2:__PRODUCT__',
        eventType: 'stock.low.detected',
        payload: { tenantId: 'tenant-1', productId: 'product-2' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-2',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
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

    const service = new LowStockOutboxPoller(
      prisma as never,
      1000,
      50,
      30000,
      dispatcher as never,
    );

    await (service as unknown as { poll: () => Promise<void> }).poll();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
  });

  it('exports the documented injection tokens for interval/batch/lock overrides', () => {
    expect(typeof LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS).toBe('symbol');
    expect(typeof LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE).toBe('symbol');
    expect(typeof LOW_STOCK_OUTBOX_POLLER_LOCK_MS).toBe('symbol');
  });

  // ─── Fix 1b (Resilience, R4) ─────────────────────────────────────
  // Regression: the per-row dispatch loop had NO try/catch. A single
  // throwing dispatcher (poison row, downstream outage that escaped
  // dispatch's own try/catch, etc.) aborted the rest of the batch AND
  // rejected out of poll() → unhandled rejection inside @Interval,
  // leaving up to 24 claimed rows locked for lockMs=60s. Wrap each
  // dispatch in its own try/catch so one bad row cannot poison the
  // batch or reject the interval tick.
  it('R4 — when dispatcher.dispatch() rejects for one row, the remaining rows still dispatch and poll() resolves (no rejected interval tick)', async () => {
    const claimed = [
      {
        id: 'evt-A',
        tenantId: 'tenant-1',
        aggregateType: 'StockAlert',
        aggregateId: 'product-A:__PRODUCT__',
        eventType: 'stock.low.detected',
        payload: { tenantId: 'tenant-1', productId: 'product-A' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-A',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
      {
        id: 'evt-B',
        tenantId: 'tenant-1',
        aggregateType: 'StockAlert',
        aggregateId: 'product-B:__PRODUCT__',
        eventType: 'stock.low.detected',
        payload: { tenantId: 'tenant-1', productId: 'product-B' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-B',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
      {
        id: 'evt-C',
        tenantId: 'tenant-1',
        aggregateType: 'StockAlert',
        aggregateId: 'product-C:__PRODUCT__',
        eventType: 'stock.low.detected',
        payload: { tenantId: 'tenant-1', productId: 'product-C' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-C',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
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

    // The MIDDLE row rejects — the others MUST still get dispatched,
    // and poll() MUST resolve cleanly (no unhandled rejection).
    const dispatcher = {
      dispatch: jest
        .fn()
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          throw new Error('dispatcher-BOOM — must NOT abort batch');
        })
        .mockImplementationOnce(async () => undefined),
    };

    const service = new LowStockOutboxPoller(
      prisma as never,
      1000,
      50,
      30000,
      dispatcher as never,
    );

    // Must resolve — NOT reject — even though dispatch rejected on row B.
    await expect(
      (service as unknown as { poll: () => Promise<void> }).poll(),
    ).resolves.toBeUndefined();

    // ALL three rows were attempted in order. The rejection on evt-B
    // is contained; the others (A and C) still flowed through.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(3, claimed[2]);
  });
});
