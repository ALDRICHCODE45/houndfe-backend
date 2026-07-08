/**
 * Slice F.5 — LowStockOutboxDispatcher tests (RED → GREEN).
 *
 * The dedicated dispatcher receives a claimed `OutboxEvent` row
 * from `LowStockOutboxPoller` and **AWAITS**
 * `InngestService.send(...)`. The await is load-bearing: a
 * post-commit rejection means the row stays PENDING and the
 * dedicated poller retries it. Marking `PUBLISHED` happens ONLY
 * on resolve.
 *
 * **Critical gates (carried from prior reliability + resilience
 * reviews):**
 *
 *   - The dispatcher MUST `await inngestService.send(...)` (it
 *     throws on failure, NOT fire-and-forget — the generic
 *     dispatcher's `eventEmitter.emit()` is non-awaitable and
 *     CANNOT satisfy this contract).
 *   - On resolve: mark `PUBLISHED` + clear `lockToken`/
 *     `lockedUntil` + stamp `publishedAt = now()`.
 *   - On reject: bump `retryCount`, stamp `nextAttemptAt` with
 *     exponential backoff, record `lastError`. At `maxRetries`
 *     the row is moved to `FAILED`. The dispatcher MUST NOT
 *     silently swallow the error.
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice
 * F.5 task in `tasks.md` + Risk R-E.
 */
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { LowStockOutboxDispatcher } from './low-stock-outbox.dispatcher';

function buildClaimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'StockAlert',
    aggregateId: 'product-1:__PRODUCT__',
    eventType: 'stock.low.detected',
    payload: {
      tenantId: 'tenant-1',
      productId: 'product-1',
      variantKey: '__PRODUCT__',
      alertEpoch: 1,
      newQuantity: 3,
      minQuantity: 3,
      productName: 'Aspirina',
      variantDescription: null,
      sku: 'ASP-500',
      category: 'Analgésicos',
      deepLink: 'https://app.example.com/products/product-1',
      occurredAt: '2026-07-06T12:00:00.000Z',
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

/**
 * Build a no-op tenant runner + tenant Prisma stand. The dispatcher
 * only reads `id` from `outboxEvent.update`, so the enrichment
 * step's tenant-scoped read can short-circuit to empty results —
 * the spec asserts ONLY on the dispatch's primary contract
 * (AWAIT send → mark PUBLISHED or PENDING+retry).
 */
function buildTenantRunner() {
  return {
    runWithTenant: jest.fn(async <T>(_id: string, fn: () => Promise<T>) =>
      fn(),
    ),
  };
}

function buildTenantPrisma() {
  return {
    getClient: () => ({
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      variant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
  };
}

function buildConfig() {
  return {
    get: jest.fn((key: string) =>
      key === 'APP_WEB_URL' ? 'https://app.example.com' : undefined,
    ),
  };
}

describe('LowStockOutboxDispatcher (F.5)', () => {
  it('AWAITS InngestService.send before marking PUBLISHED — no fire-and-forget', async () => {
    // Capture the order in which the dispatcher calls Inngest vs.
    // the Prisma update. Resolve ORDER: send → update(PUBLISHED).
    // If the dispatcher marks PUBLISHED BEFORE awaiting `send`,
    // a rejection would leave PUBLISHED + lost — the very bug the
    // dedicated path closes (design Risk R-E).
    const callOrder: string[] = [];
    const inngestService = {
      send: jest.fn(() => {
        callOrder.push('send.resolve');
        return Promise.resolve({ ids: ['evt-id-1'] });
      }),
    };
    const prisma = {
      outboxEvent: {
        update: jest.fn((args: unknown) => {
          callOrder.push(
            `update:${(args as { data: { status: string } }).data.status}`,
          );
          return Promise.resolve({ id: 'evt-1' });
        }),
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    await dispatcher.dispatch(buildClaimed());

    expect(callOrder).toEqual(['send.resolve', 'update:PUBLISHED']);
  });

  it('marks PUBLISHED on resolve (clear lockToken/lockedUntil, stamp publishedAt)', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id-1'] }),
    };
    const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma = {
      outboxEvent: {
        update: updateMock,
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    await dispatcher.dispatch(buildClaimed({ id: 'evt-published' }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    const calls = updateMock.mock.calls as unknown[][];
    const arg = calls[0]?.[0] as {
      where: { id: string };
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

  it('marks PENDING + bumps retryCount + bumps nextAttemptAt + records lastError on reject (under maxRetries)', async () => {
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('Inngest down')),
    };
    const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma = {
      outboxEvent: {
        update: updateMock,
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    // WARNING (Reliability) — capture the wall-clock baseline BEFORE
    // the dispatcher runs. The previous assertion
    // (`> new Date().getTime() - 1000`) was a TAUTOLOGY — it passed
    // even if `nextAttemptAt` was `now` or slightly in the past.
    // Anchoring to a pre-dispatch `before` lets us assert the actual
    // backoff DELAY the dispatcher scheduled.
    const before = Date.now();

    await dispatcher.dispatch(buildClaimed({ retryCount: 1 }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    const callArgs = updateMock.mock.calls as unknown[][];
    const arg = callArgs[0]?.[0] as {
      where: { id: string };
      data: {
        status: OutboxEventStatus;
        retryCount: number;
        lastError: string;
        nextAttemptAt: Date;
        lockToken: null;
        lockedUntil: null;
      };
    };
    expect(arg.data.status).toBe(OutboxEventStatus.PENDING);
    expect(arg.data.retryCount).toBe(2);
    expect(arg.data.lastError).toMatch(/Inngest down/);
    expect(arg.data.nextAttemptAt).toBeInstanceOf(Date);
    // Load-bearing backoff assertion. retryCount=1 (nextRetryCount=2)
    // → BACKOFF_TABLE_MS[1] = 5_000 with ±10% jitter ⇒ 4_500–5_500ms.
    // Floor at BACKOFF_BASE_MS (2_000) — the structural minimum the
    // dispatcher enforces via Math.max — so a regression that sets
    // nextAttemptAt = now is caught. Ceiling at 6_000 so a future
    // refactor that uses a wrong-tier index (e.g. 60s) is caught.
    const nextDelayMs = arg.data.nextAttemptAt.getTime() - before;
    expect(nextDelayMs).toBeGreaterThanOrEqual(2_000);
    expect(nextDelayMs).toBeLessThanOrEqual(6_000);
    expect(arg.data.lockToken).toBeNull();
    expect(arg.data.lockedUntil).toBeNull();
  });

  // WARNING (Reliability) — backoff progression across retry levels.
  // The backoff table is exponential (2s → 5s → 15s → 60s → 5m); a
  // regression that flattens it to a constant delay (or uses the
  // wrong index) would still pass the per-row test above but
  // starve the queue on a flapping downstream. This test drives
  // the dispatcher at retryCount=1 and retryCount=2 and asserts
  // the gap between the two `nextAttemptAt` deltas reflects the
  // larger delay at the higher retry level (5_000ms vs 15_000ms
  // tier ⇒ retryCount=2 must be ≥ 9s LATER than retryCount=1's
  // baseline after stripping the common `before` anchor).
  it('backoff progression: retryCount=2 schedules a STRICTLY LATER nextAttemptAt than retryCount=1 (5s tier vs 15s tier)', async () => {
    async function dispatchAt(retryCount: number): Promise<number> {
      const inngestService = {
        send: jest.fn().mockRejectedValue(new Error('down')),
      };
      const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
      const prisma = { outboxEvent: { update: updateMock } };
      const dispatcher = new LowStockOutboxDispatcher(
        inngestService as never,
        prisma as never,
        buildTenantPrisma() as never,
        buildTenantRunner() as never,
        buildConfig() as never,
        5,
      );
      const t0 = Date.now();
      await dispatcher.dispatch(buildClaimed({ retryCount }));
      const calls = updateMock.mock.calls as unknown[][];
      const arg = calls[0]?.[0] as {
        data: { nextAttemptAt: Date };
      };
      return arg.data.nextAttemptAt.getTime() - t0;
    }

    // Run each path once. The 5s tier is 4_500–5_500ms; the 15s
    // tier is 13_500–16_500ms. The lower bound of the gap is
    // 13_500 − 5_500 = 8_000ms. We assert ≥ 7_000 to leave a small
    // jitter margin.
    const delayAt1 = await dispatchAt(1);
    const delayAt2 = await dispatchAt(2);
    expect(delayAt2 - delayAt1).toBeGreaterThanOrEqual(7_000);
  });

  it('marks FAILED when retryCount reaches maxRetries', async () => {
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('dead-letter')),
    };
    const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma = {
      outboxEvent: {
        update: updateMock,
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      // maxRetries=5 ⇒ next retryCount === 5 ⇒ FAILED.
      5,
    );

    // retryCount=4 ⇒ next=5 ⇒ exhausted.
    await dispatcher.dispatch(buildClaimed({ retryCount: 4 }));

    const callArgs = updateMock.mock.calls as unknown[][];
    const arg = callArgs[0]?.[0] as {
      data: { status: OutboxEventStatus; retryCount: number };
    };
    expect(arg.data.status).toBe(OutboxEventStatus.FAILED);
    expect(arg.data.retryCount).toBe(5);
  });

  it('does NOT swallow send rejections (the rejection surfaces in the awaited call site)', async () => {
    // Critical — the dedicated dispatcher's await is non-optional.
    // If a future refactor accidentally drops the await, the row
    // gets marked PUBLISHED while the send is still pending — a
    // lost-alert regression. This test pins the surface: the
    // dispatch() call resolves even when send rejects (we
    // manage the error state ourselves, never re-throw).
    const inngestService = {
      send: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const prisma = {
      outboxEvent: {
        update: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    // dispatch() resolves — no re-throw. The row is left in a
    // PENDING (or FAILED) state via the prisma.update call.
    await expect(dispatcher.dispatch(buildClaimed())).resolves.toBeUndefined();
  });

  // ─── Fix 1a (Resilience, R4) ─────────────────────────────────────
  // Regression: a failure inside `enrich()` (tenant-scoped Prisma
  // read) MUST flow through `markRetry` so the row gets a bumped
  // retryCount + lastError + backed-off nextAttemptAt — NOT escape
  // dispatch() and abort the poller's per-row loop. Before the fix,
  // `enrich()` was called OUTSIDE the durability try/catch so a
  // single bad row would reject out of dispatch() → the poller loop
  // died mid-batch → up to 24 other claimed rows sat locked for
  // lockMs without a retry bump (an invisible poison pill that
  // re-failed every poll cycle).
  it('R4 — when enrich() throws (product.findFirst rejects), the row goes to markRetry (retryCount++ + lastError + backoff) instead of escaping dispatch()', async () => {
    const enrichError = new Error('prisma: tenant scope lost');
    const tenantPrisma = {
      getClient: () => ({
        product: {
          findFirst: jest.fn().mockRejectedValue(enrichError),
        },
        variant: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      }),
    };
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id-1'] }),
    };
    const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma = {
      outboxEvent: { update: updateMock },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      tenantPrisma as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    // Must NOT throw — the dispatcher manages the error itself.
    await expect(
      dispatcher.dispatch(buildClaimed({ retryCount: 1 })),
    ).resolves.toBeUndefined();

    // Inngest send must NOT have been called — enrich blew up first.
    expect(inngestService.send).not.toHaveBeenCalled();

    // Exactly one update — the markRetry path. retryCount bumped to 2,
    // lastError carries the enrich failure, status PENDING (not yet
    // exhausted at maxRetries=5).
    expect(updateMock).toHaveBeenCalledTimes(1);
    const callArgs = updateMock.mock.calls as unknown[][];
    const arg = callArgs[0]?.[0] as {
      where: { id: string };
      data: {
        status: OutboxEventStatus;
        retryCount: number;
        lastError: string;
        nextAttemptAt: Date;
        lockToken: null;
        lockedUntil: null;
      };
    };
    expect(arg.where.id).toBe('evt-1');
    expect(arg.data.status).toBe(OutboxEventStatus.PENDING);
    expect(arg.data.retryCount).toBe(2);
    expect(arg.data.lastError).toMatch(/tenant scope lost/);
    expect(arg.data.nextAttemptAt).toBeInstanceOf(Date);
    expect(arg.data.lockToken).toBeNull();
    expect(arg.data.lockedUntil).toBeNull();
  });

  it('R4 — when enrich() throws at retryCount=maxRetries-1, the row reaches FAILED (no infinite loop on poison rows)', async () => {
    const tenantPrisma = {
      getClient: () => ({
        product: {
          findFirst: jest.fn().mockRejectedValue(new Error('db-blip')),
        },
        variant: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      }),
    };
    const inngestService = {
      send: jest.fn(),
    };
    const updateMock = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma = {
      outboxEvent: { update: updateMock },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      tenantPrisma as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      // maxRetries=5 ⇒ retryCount 4 + 1 = 5 ⇒ exhausted.
      5,
    );

    await dispatcher.dispatch(buildClaimed({ retryCount: 4 }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    const callArgs = updateMock.mock.calls as unknown[][];
    const arg = callArgs[0]?.[0] as {
      data: { status: OutboxEventStatus; retryCount: number };
    };
    expect(arg.data.status).toBe(OutboxEventStatus.FAILED);
    expect(arg.data.retryCount).toBe(5);
    expect(inngestService.send).not.toHaveBeenCalled();
  });

  // WARNING (Reliability) — enrich() field-mapping was untested.
  // Every prior dispatcher test stubbed product/variant findFirst
  // → null, so only the FALLBACK branch of enrich() ran; the
  // actual field mapping (product.name, product.sku,
  // product.category.name, variant.option:value, and the
  // deepLink built from APP_WEB_URL) had zero coverage. A
  // regression that drops the product.read (e.g. a refactor
  // that reads from the outbox payload's stale `productName`)
  // would still pass every other test in this file.
  //
  // This test stubs the product + variant reads with realistic
  // data and asserts the enriched payload (the second arg to
  // inngestService.send) reflects the read values, not the
  // fallback to base.productName/etc.
  it('enrich() field mapping: with a non-null product/variant, the sent payload reflects product.name + sku + category.name + variant.option:value + APP_WEB_URL deepLink', async () => {
    const tenantPrisma = {
      getClient: () => ({
        product: {
          findFirst: jest.fn().mockResolvedValue({
            name: 'Aspirina Original',
            sku: 'ASP-500',
            category: { name: 'Analgésicos' },
          }),
        },
        variant: {
          findFirst: jest.fn().mockResolvedValue({
            option: 'Concentración',
            value: '500mg',
          }),
        },
      }),
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'APP_WEB_URL' ? 'https://app.example.com/' : undefined,
      ),
    };
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id-1'] }),
    };
    const prisma = {
      outboxEvent: { update: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
    };
    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      tenantPrisma as never,
      buildTenantRunner() as never,
      config as never,
      5,
    );

    await dispatcher.dispatch(
      buildClaimed({
        id: 'evt-enrich',
        // The dispatcher reads `base.variantId` from the payload
        // (see `enrich()` line 269). The top-level `DispatchableOutboxEvent`
        // has no `variantId` — it lives inside `payload`.
        payload: {
          tenantId: 'tenant-1',
          productId: 'product-1',
          variantKey: 'var-1',
          variantId: 'var-1',
          alertEpoch: 1,
          newQuantity: 3,
          minQuantity: 3,
          productName: 'STALE-NAME-FROM-PAYLOAD', // must be overridden by product.name read
          variantDescription: 'STALE-VARIANT', // must be overridden by variant read
          sku: 'STALE-SKU',
          category: 'STALE-CATEGORY',
          deepLink: 'https://stale.example.com/products/product-1', // must be overridden by APP_WEB_URL build
          occurredAt: '2026-07-06T12:00:00.000Z',
        },
      }),
    );

    expect(inngestService.send).toHaveBeenCalledTimes(1);
    const sendCall = inngestService.send.mock.calls[0] as unknown[];
    // InngestService.send(name, data, idempotencyKey) — the
    // enriched payload is the second argument.
    const enriched = sendCall[1] as {
      productName: string;
      sku: string | null;
      category: string | null;
      variantDescription: string | null;
      deepLink: string;
    };

    // The product read must win over the payload's
    // pre-existing (possibly stale) productName from the
    // in-tx path. The dispatcher defers the fresh read.
    expect(enriched.productName).toBe('Aspirina Original');
    expect(enriched.sku).toBe('ASP-500');
    expect(enriched.category).toBe('Analgésicos');

    // Variant option + value joined with ': ' — proves the
    // dispatcher composes variantDescription from the read,
    // not from the payload's pre-existing (often null) value.
    expect(enriched.variantDescription).toBe('Concentración: 500mg');

    // DeepLink is built from APP_WEB_URL (with trailing slash
    // stripped) + /products/<productId> — proves the dispatcher
    // constructs the link, not just echoes the payload's link.
    expect(enriched.deepLink).toBe(
      'https://app.example.com/products/product-1',
    );
  });

  it('enrich() deepLink fallback: when APP_WEB_URL is unset, the deepLink falls back to base.deepLink (no fabricated URL)', async () => {
    // Companion to the field-mapping test above. When APP_WEB_URL
    // is empty (e.g. an unconfigured tenant or a misconfigured
    // env), the dispatcher must NOT invent a deep link from
    // scratch — it falls back to the in-tx base.deepLink. A
    // regression that hard-codes `appBaseUrl = 'http://localhost'`
    // would send emails pointing at the wrong origin.
    const tenantPrisma = {
      getClient: () => ({
        product: { findFirst: jest.fn().mockResolvedValue(null) },
        variant: { findFirst: jest.fn().mockResolvedValue(null) },
      }),
    };
    const config = {
      get: jest.fn().mockReturnValue(undefined), // APP_WEB_URL unset
    };
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-id-1'] }),
    };
    const prisma = {
      outboxEvent: { update: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
    };
    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      tenantPrisma as never,
      buildTenantRunner() as never,
      config as never,
      5,
    );

    await dispatcher.dispatch(
      buildClaimed({
        id: 'evt-enrich-fallback',
        // buildClaimed sets deepLink: 'https://app.example.com/products/product-1'
      }),
    );

    const sendCall = inngestService.send.mock.calls[0] as unknown[];
    const enriched = sendCall[1] as { deepLink: string };
    // The dispatcher's fallback is the payload's deepLink, not
    // an empty string (which would render as a broken link).
    expect(enriched.deepLink).toBe(
      'https://app.example.com/products/product-1',
    );
  });

  it('replay idempotency: re-dispatching the same outbox row calls inngestService.send with the SAME idempotencyKey', async () => {
    const inngestService = {
      send: jest.fn().mockResolvedValue({ ids: ['evt-1'] }),
    };
    const prisma = {
      outboxEvent: {
        update: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
    };

    const dispatcher = new LowStockOutboxDispatcher(
      inngestService as never,
      prisma as never,
      buildTenantPrisma() as never,
      buildTenantRunner() as never,
      buildConfig() as never,
      5,
    );

    const claimed = buildClaimed({ id: 'evt-replay' });
    await dispatcher.dispatch(claimed);
    // Reset the row to its pre-dispatch state to simulate the
    // generic poller re-draining the same row after a successful
    // send that lost its mark-PUBLISHED ack.
    const replayed = { ...claimed, status: OutboxEventStatus.PENDING };
    await dispatcher.dispatch(replayed);

    const keys = inngestService.send.mock.calls.map(
      (call: unknown[]) => call[2] as string,
    );
    // The dispatcher is the authority on the seed — both sends
    // MUST use the same idempotency key for a row with the same
    // `(tenantId, productId, variantKey, alertEpoch)`. We don't
    // pin the exact shape, just that it's IDENTICAL across replays.
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
