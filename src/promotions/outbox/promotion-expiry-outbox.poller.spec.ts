/**
 * PromotionExpiryOutboxPoller tests — pca-3c3b.
 *
 * The dedicated expiry poller claims ONLY `promotion.expiring.detected`
 * PENDING rows from the outbox table — disjoint from the generic
 * `OutboxPollerService` (which excludes that `eventType`) and from every
 * sibling dedicated poller (low-stock / hr-time-off / delivery-routes /
 * promotion-near-capacity). Claim uses `FOR UPDATE SKIP LOCKED` + a
 * per-batch UUID `lockToken` / `lockedUntil` lease so concurrent pollers
 * cannot double-claim a row.
 *
 * Claimed rows are handed to `PromotionExpiryOutboxDispatcher`, whose
 * `dispatch` AWAITS the Inngest send — the poller must therefore await
 * every `dispatch` (sequential durable delivery) and must fence each row
 * in its own try/catch so one poison row cannot abort the batch nor
 * reject out of the `@Interval` tick (which would leave the whole batch
 * leased for `lockMs`).
 *
 * The `@Interval` decorator is owned by the framework; this spec
 * exercises the underlying `claimBatch()` / `poll()` public seams
 * directly with a fake Prisma transaction (same mocking style as the
 * sibling `promotion-capacity-outbox.poller.spec.ts`).
 *
 * Coverage:
 *   - claim SELECT carries the EXCLUSIVE predicate
 *     `"eventType" = 'promotion.expiring.detected'` + the
 *     status / nextAttemptAt / lockedUntil clauses + SKIP LOCKED.
 *   - claim UPDATE leases the rows with a UUID lockToken + lockedUntil.
 *   - empty PENDING batch → [] and the dispatcher is NOT called.
 *   - claimed rows → every row forwarded to dispatcher.dispatch(event).
 *   - dispatches are AWAITED one at a time (no overlap).
 *   - per-row try/catch: one throwing (rejected or synchronous) dispatch
 *     does not reject poll() nor abort the remaining rows.
 *   - intervalMs throttle: a second poll() within intervalMs is a no-op.
 *   - module compilation: the dedicated module graph resolves the
 *     poller, the dispatcher, and the expiry retry-token provider.
 */
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { OutboxEventStatus } from '@prisma/client';
import { InngestService } from '../../inngest/inngest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES,
  PromotionExpiryOutboxDispatcher,
} from './promotion-expiry-outbox.dispatcher';
import { PromotionExpiryOutboxModule } from './promotion-expiry-outbox.module';
import {
  PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE,
  PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS,
  PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS,
  PromotionExpiryOutboxPoller,
} from './promotion-expiry-outbox.poller';

const EVENT_TYPE = 'promotion.expiring.detected';
const EXCLUSIVE_PREDICATE = `"eventType" = '${EVENT_TYPE}'`;
const LOCK_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildClaimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'Promotion',
    aggregateId: 'promotion-1',
    eventType: EVENT_TYPE,
    payload: {
      tenantId: 'tenant-1',
      promotionId: 'promotion-1',
      endDate: '2026-10-01T00:00:00.000Z',
      endDateFingerprint: '2026-10-01T00:00:00.000Z',
      occurredAt: '2026-09-24T00:00:00.000Z',
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

interface CapturedQuery {
  sql: string;
  args: unknown[];
}

/**
 * Fake `prisma.$transaction` that records every raw call and answers the
 * claim SELECT / lease UPDATE from the supplied fixtures.
 */
function capturingTransaction(
  captured: CapturedQuery[],
  selectRows: Array<{ id: string }>,
  updateRows: DispatchableOutboxEvent[],
): (work: (tx: unknown) => Promise<unknown>) => Promise<unknown> {
  return (work: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockImplementation((sql: string, ...args: unknown[]) => {
          captured.push({ sql, args });
          if (/SELECT\s+id\s+FROM\s+outbox_events/i.test(sql)) {
            return Promise.resolve(selectRows);
          }
          if (/UPDATE\s+outbox_events/i.test(sql)) {
            return Promise.resolve(updateRows);
          }
          return Promise.resolve([]);
        }),
    };
    return work(tx);
  };
}

function claimCall(captured: CapturedQuery[]): CapturedQuery {
  const call = captured.find((c) =>
    /SELECT\s+id\s+FROM\s+outbox_events/i.test(c.sql),
  );
  if (!call) {
    throw new Error('claim SELECT was never issued');
  }
  return call;
}

function leaseCall(captured: CapturedQuery[]): CapturedQuery {
  const call = captured.find((c) => /UPDATE\s+outbox_events/i.test(c.sql));
  if (!call) {
    throw new Error('lease UPDATE was never issued');
  }
  return call;
}

function buildPoller(
  prisma: unknown,
  dispatcher: unknown,
  intervalMs = 5000,
  batchSize = 25,
  lockMs = 60000,
): PromotionExpiryOutboxPoller {
  return new PromotionExpiryOutboxPoller(
    prisma as never,
    intervalMs,
    batchSize,
    lockMs,
    dispatcher as never,
  );
}

async function flushUntil(
  predicate: () => boolean,
  maxTicks = 200,
): Promise<void> {
  for (let tick = 0; tick < maxTicks && !predicate(); tick += 1) {
    await Promise.resolve();
  }
}

/** Compiles the dedicated module graph with its external deps stubbed. */
async function compileExpiryModule(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [PromotionExpiryOutboxModule] })
    .overrideProvider(PrismaService)
    .useValue({ $transaction: jest.fn().mockResolvedValue([]) })
    .overrideProvider(InngestService)
    .useValue({ send: jest.fn() })
    .compile();
}

describe('PromotionExpiryOutboxPoller (pca-3c3b)', () => {
  it('claim SELECT targets ONLY status=PENDING AND eventType=promotion.expiring.detected (DISJOINT from the generic + sibling pollers)', async () => {
    const captured: CapturedQuery[] = [];
    const service = buildPoller(
      { $transaction: capturingTransaction(captured, [], []) },
      { dispatch: jest.fn() },
    );

    await service.claimBatch();

    const claimSql = claimCall(captured).sql;
    expect(claimSql).toContain(`status = 'PENDING'`);
    // The EXCLUSIVE predicate — this poller claims ONLY expiry rows.
    expect(claimSql).toContain(EXCLUSIVE_PREDICATE);
    expect(claimSql).toContain(`"nextAttemptAt" <= NOW()`);
    // Lease decay: unlocked OR expired lease.
    expect(claimSql).toContain(
      `"lockedUntil" IS NULL OR "lockedUntil" < NOW()`,
    );
    expect(claimSql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
    // The dedicated poller must NOT carry the NEGATIVE predicate (that
    // belongs to the generic poller) nor a multi-type `IN` list.
    expect(claimSql).not.toContain('NOT IN');
    expect(claimSql).not.toContain(`"eventType" <>`);
    // TRIANGULATE — exclusivity, not merely a different name: the claim
    // predicate must not match any sibling dedicated event type, so this
    // poller can never steal a low-stock / hr-time-off / delivery-routes /
    // near-capacity row (those keep their own dedicated pollers).
    expect(claimSql).not.toContain(`'stock.low.detected'`);
    expect(claimSql).not.toContain(`'hr.timeoff.requested'`);
    expect(claimSql).not.toContain(`'delivery.next_stop.notify'`);
    expect(claimSql).not.toContain(`'promotion.near_capacity.detected'`);
  });

  it('leases the claimed rows with a per-batch UUID lockToken and a lockedUntil lease (UPDATE ... RETURNING)', async () => {
    const captured: CapturedQuery[] = [];
    const claimed = [buildClaimed()];
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          [{ id: 'evt-1' }],
          claimed,
        ),
      },
      { dispatch: jest.fn().mockResolvedValue(undefined) },
      5000,
      25,
      60000,
    );

    const events = await service.claimBatch();

    const lease = leaseCall(captured);
    expect(lease.sql).toContain('SET "lockToken" = $1');
    expect(lease.sql).toContain(
      `"lockedUntil" = NOW() + ($2 * INTERVAL '1 second')`,
    );
    expect(lease.sql).toContain('WHERE id = ANY($3::text[])');
    // UUID lockToken + lockMs converted to seconds + the exact claimed ids.
    expect(lease.args[0]).toMatch(LOCK_TOKEN_PATTERN);
    expect(lease.args[1]).toBe(60);
    expect(lease.args[2]).toEqual(['evt-1']);
    expect(events).toEqual(claimed);
  });

  it('draws a fresh UUID lockToken for every claim batch', async () => {
    const captured: CapturedQuery[] = [];
    const transaction = capturingTransaction(
      captured,
      [{ id: 'evt-1' }],
      [buildClaimed()],
    );
    const service = buildPoller(
      { $transaction: transaction },
      { dispatch: jest.fn().mockResolvedValue(undefined) },
    );

    await service.claimBatch();
    captured.length = 0;
    await service.claimBatch();

    const firstToken = leaseCall(captured).args[0];
    captured.length = 0;
    await service.claimBatch();
    const secondToken = leaseCall(captured).args[0];

    expect(typeof firstToken).toBe('string');
    expect(firstToken).not.toEqual(secondToken);
  });

  it('empty PENDING batch → claimBatch() returns [] and poll() does NOT call the dispatcher', async () => {
    const captured: CapturedQuery[] = [];
    const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const service = buildPoller(
      { $transaction: capturingTransaction(captured, [], []) },
      dispatcher,
    );

    const claimed = await service.claimBatch();
    expect(claimed).toEqual([]);

    await service.poll();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('hands each claimed row to the dedicated dispatcher (poll() forwards every row by identity)', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-1', lockToken: 'lock-1' }),
      buildClaimed({ id: 'evt-2', lockToken: 'lock-2' }),
    ];
    const captured: CapturedQuery[] = [];
    const dispatch = jest.fn<Promise<void>, [DispatchableOutboxEvent]>();
    dispatch.mockResolvedValue(undefined);
    const dispatcher = { dispatch };
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          claimed.map((event) => ({ id: event.id })),
          claimed,
        ),
      },
      dispatcher,
    );

    await service.poll();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
    // The leased row (lockToken included) is forwarded untouched — the
    // dispatcher's lock-token CAS depends on that exact lease value.
    expect(dispatch.mock.calls[0][0]).toBe(claimed[0]);
  });

  // ─── Await guarantee ──────────────────────────────────────────────
  // `dispatch` awaits the Inngest send and only then marks the row
  // PUBLISHED. If the poller did not await, a second row would be sent
  // while the first is still in flight and the sequential durability
  // boundary would be lost.
  it('awaits each dispatch before starting the next row (no overlapping sends)', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-1' }),
      buildClaimed({ id: 'evt-2' }),
    ];
    const captured: CapturedQuery[] = [];
    const pendingResolvers: Array<() => void> = [];
    const dispatch = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingResolvers.push(resolve);
        }),
    );
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          claimed.map((event) => ({ id: event.id })),
          claimed,
        ),
      },
      { dispatch },
    );

    const pollPromise = service.poll();
    await flushUntil(() => dispatch.mock.calls.length > 0);

    // First dispatch is in flight → the second row MUST NOT be started.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pendingResolvers).toHaveLength(1);

    // Resolving the first row releases the second — only then does the
    // poller start it (a non-awaiting poller would already have 2 calls).
    pendingResolvers[0]();
    await flushUntil(() => dispatch.mock.calls.length > 1);
    expect(dispatch).toHaveBeenCalledTimes(2);

    pendingResolvers[1]();
    await pollPromise;
  });

  // ─── Per-row try/catch (outer fence, mirrors near-capacity) ───────
  // A single throwing dispatcher must NOT abort the rest of the batch
  // NOR reject out of poll() — an unhandled rejection inside
  // `@Interval` would leave up to batchSize claimed rows leased for
  // lockMs=60s.
  it('when dispatcher.dispatch() rejects for one row, the remaining rows still dispatch and poll() resolves', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-A' }),
      buildClaimed({ id: 'evt-B' }),
      buildClaimed({ id: 'evt-C' }),
    ];
    const captured: CapturedQuery[] = [];
    const dispatch = jest
      .fn()
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() =>
        Promise.reject(new Error('dispatcher-BOOM — must NOT abort batch')),
      )
      .mockImplementationOnce(() => Promise.resolve(undefined));
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          claimed.map((event) => ({ id: event.id })),
          claimed,
        ),
      },
      { dispatch },
    );

    await expect(service.poll()).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenNthCalledWith(1, claimed[0]);
    expect(dispatch).toHaveBeenNthCalledWith(2, claimed[1]);
    expect(dispatch).toHaveBeenNthCalledWith(3, claimed[2]);
  });

  // TRIANGULATE — the poller owns only the lease; it never clears or
  // rewrites row state when a dispatch fails. The dispatcher's
  // lock-token CAS is the single terminal writer, so a fenced row stays
  // leased until `lockedUntil` expires and can then be reclaimed, and no
  // second claimant can observe it as unlocked in the meantime.
  it('issues no terminal writes when a dispatch throws (row stays leased for the dispatcher CAS)', async () => {
    const claimed = [buildClaimed({ id: 'evt-A' })];
    const captured: CapturedQuery[] = [];
    const dispatch = jest
      .fn<Promise<void>, [DispatchableOutboxEvent]>()
      .mockRejectedValue(new Error('send-BOOM'));
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          [{ id: 'evt-A' }],
          claimed,
        ),
      },
      { dispatch },
    );

    await expect(service.poll()).resolves.toBeUndefined();

    // Exactly two raw statements: the claim SELECT and the lease UPDATE.
    expect(captured).toHaveLength(2);
    expect(captured[1].sql).toContain('SET "lockToken" = $1');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // TRIANGULATE — a synchronous throw (not a rejected promise) must be
  // fenced identically, including when it happens on the LAST row so no
  // remaining-row assertion can mask a missing catch.
  it('fences a synchronous dispatcher throw on the LAST row without rejecting poll()', async () => {
    const claimed = [
      buildClaimed({ id: 'evt-A' }),
      buildClaimed({ id: 'evt-B' }),
    ];
    const captured: CapturedQuery[] = [];
    const dispatch = jest
      .fn<Promise<void>, [DispatchableOutboxEvent]>()
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => {
        throw new Error('synchronous-BOOM — must NOT reject poll()');
      });
    const service = buildPoller(
      {
        $transaction: capturingTransaction(
          captured,
          claimed.map((event) => ({ id: event.id })),
          claimed,
        ),
      },
      { dispatch },
    );

    await expect(service.poll()).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('throttles: a second poll() within intervalMs does NOT claim again', async () => {
    let transactionCount = 0;
    const prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        return capturingTransaction([], [], [])(work);
      },
    };
    const service = buildPoller(
      prisma,
      { dispatch: jest.fn().mockResolvedValue(undefined) },
      5000,
    );

    // First poll claims (lastPollAt starts at 0 → elapsed is huge).
    await service.poll();
    // Second poll immediately after → within intervalMs → no-op.
    await service.poll();

    expect(transactionCount).toBe(1);
  });

  it('exports the documented injection tokens for interval/batch/lock overrides', () => {
    expect(typeof PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS).toBe('symbol');
    expect(typeof PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE).toBe('symbol');
    expect(typeof PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS).toBe('symbol');
  });
});

describe('PromotionExpiryOutboxModule (pca-3c3b)', () => {
  it('compiles the dedicated module graph and resolves the poller, dispatcher, and expiry retry-token provider', async () => {
    const moduleRef = await compileExpiryModule();

    expect(moduleRef.get(PromotionExpiryOutboxPoller)).toBeInstanceOf(
      PromotionExpiryOutboxPoller,
    );
    expect(moduleRef.get(PromotionExpiryOutboxDispatcher)).toBeInstanceOf(
      PromotionExpiryOutboxDispatcher,
    );
    // The dispatcher's retry-token provider is wired (default 5) — without
    // it Nest cannot construct the dispatcher.
    expect(
      moduleRef.get<number>(PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES),
    ).toBe(5);
    expect(
      moduleRef.get<number>(PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE),
    ).toBe(25);

    await moduleRef.close();
  });

  // TRIANGULATE — the module must keep the poller's throttle override
  // resolvable too; a graph that resolves the class but not the token
  // would only fail at runtime under a non-default env.
  it('resolves the interval and lock override tokens', async () => {
    const moduleRef = await compileExpiryModule();

    expect(
      moduleRef.get<number>(PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS),
    ).toBe(5000);
    expect(moduleRef.get<number>(PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS)).toBe(
      60000,
    );

    await moduleRef.close();
  });
});
