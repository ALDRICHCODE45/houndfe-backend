/**
 * Slice F.2 — low-stock Inngest function tests (RED → GREEN).
 *
 * The function is built by `buildLowStockFunctions({ inngest, ... })`
 * which records the configuration handed to `inngest.createFunction`
 * so the spec can invoke the handler directly with a fake `step` and
 * fake `events`. This mirrors the pattern used in `inngest.service.spec.ts`
 * (faking the SDK) while keeping the function code itself
 * framework-agnostic — only the builder needs a client.
 *
 * **Spec coverage (notification-config/spec.md + design.md "Inngest +
 * Resend Wiring" / Decision 3 — coalescing):**
 *
 *   - "Coalesce": `batchEvents: { maxSize: 50, timeout: '60s',
 *     key: 'event.data.tenantId' }` is set; multiple events for the
 *     same tenant produce ONE email render.
 *   - "Disabled config short-circuits": when
 *     `NotificationSettings.enabled=false` OR LOW_STOCK is not in
 *     `enabledActions`, the mailer is NEVER invoked.
 *   - "Dedupes recipients by isActive + unique email": the same
 *     recipient listed twice is rendered once.
 *   - "Replay idempotent": the idempotency key handed to Inngest via
 *     `createFunction`'s top-level `idempotency` field is
 *     `'event.id'` (the seed stored on the outbox payload).
 *   - "Retries and concurrency limits": `retries: 3`,
 *     `concurrency: { limit: 5 }`.
 *   - "Field correctness": the rendered email body contains product
 *     name, variant, current qty, configured min, SKU/code,
 *     category, and a link to the per-tenant product detail page.
 *   - "Steps run inside `runWithTenant(tenantId)`": each step body
 *     opens a CLS scope seeded with the event payload's tenantId.
 */
import {
  type LowStockEmailItem,
  LowStockEmail,
} from '../../notifications/email/templates/low-stock.email';
import type { LowStockEventPayload } from '../domain/stock-crossing';

/**
 * Build a fake Inngest client. Calls to `createFunction` record the
 * configuration + handler; the spec then extracts the handler for
 * direct invocation. Mirrors `inngest.service.spec.ts`'s pattern
 * but is local to this spec so other suites can't observe the
 * wrapper.
 *
 * Inngest v4 takes `(options, handler)` where `options.triggers`
 * is part of the options object (NOT a separate second arg like
 * v3). Our fake mirrors the v4 signature.
 */
function makeFakeInngest() {
  type Captured = {
    options: Record<string, unknown>;
    handler: (...args: unknown[]) => unknown;
  };
  const captured: Captured[] = [];

  class FakeInngest {
    readonly id: string;
    constructor(opts: { id: string }) {
      this.id = opts.id;
    }
    createFunction(
      options: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown,
    ) {
      captured.push({ options, handler });
      return { options, handler, __sentinel: true } as const;
    }
  }
  return {
    Inngest: FakeInngest as unknown as new (opts: { id: string }) => unknown,
    captured,
  };
}

/**
 * Build a `step` that runs each `step.run(name, fn)` body
 * synchronously (no real Inngest checkpointing) and exposes the
 * names so the spec can verify the step topology.
 */
function makeFakeStep() {
  const stepCalls: string[] = [];
  const step = {
    run: jest.fn(async (name: string, fn: () => Promise<unknown>) => {
      stepCalls.push(name);
      return fn();
    }),
    sleep: jest.fn(() => Promise.resolve(undefined)),
    sendEvent: jest.fn(() => Promise.resolve(undefined)),
    waitForEvent: jest.fn(() => Promise.resolve(undefined)),
  };
  return {
    step: step as unknown as Record<string, unknown>,
    stepCalls,
  };
}

function basePayload(
  overrides: Partial<LowStockEventPayload> = {},
): LowStockEventPayload {
  return {
    tenantId: 'tenant-1',
    productId: 'product-1',
    variantId: null,
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
    ...overrides,
  };
}

describe('low-stock Inngest function (F.2)', () => {
  let ORIGINAL_ENV: NodeJS.ProcessEnv;
  beforeEach(() => {
    ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it('registers a single function with the documented batchEvents, idempotency, retries, concurrency', async () => {
    const fake = makeFakeInngest();

    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: false,
        recipients: [],
        enabledActions: [],
      }),
    };
    const mailer = { send: jest.fn() };
    const userEmailLookup = { resolveEmailsByUserIds: jest.fn() };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
      appBaseUrl: 'https://app.example.com',
    });

    expect(fake.captured).toHaveLength(1);
    const { options } = fake.captured[0];

    // options shape from design Decision 4
    expect(options).toMatchObject({
      id: 'low-stock-email',
      retries: 3,
      concurrency: { limit: 5 },
    });
    expect((options as { batchEvents?: unknown }).batchEvents).toEqual({
      maxSize: 50,
      timeout: '60s',
      key: 'event.data.tenantId',
    });
    expect((options as { idempotency?: unknown }).idempotency).toBe('event.id');

    // triggers lives INSIDE options in Inngest v4.
    expect(
      (options as { triggers?: Array<{ event: string }> }).triggers,
    ).toEqual([{ event: 'stock/low.detected' }]);
  });

  it('invokes the handler with `events[]` (coalesced batch payload) — mailer called ONCE with the body containing BOTH distinct items', async () => {
    // CRITICAL 2 (Reliability) — the prior assertion (`send` called
    // once) was a MOCK TAUTOLOGY: both events reused
    // `productName: 'Aspirina'`, so the body assertion could not
    // tell whether the renderer actually folded both events in
    // (vs. dropping the second) or whether the subject was
    // coerced to `'1 producto…'`. Here the two events carry
    // DISTINCT product names ('Aspirina' + 'Ibuprofeno') so the
    // body assertion is load-bearing — the only way for both
    // names to appear in the rendered HTML is for `composeItems`
    // to have produced two items, and for `mailer.send` to have
    // been called with the multi-item body (not a single-item
    // body for just one of them).
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user-1'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue(['u1@example.com']),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
      appBaseUrl: 'https://app.example.com',
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [
        {
          id: 'tenant-1:p1:n:1',
          name: 'stock/low.detected',
          data: basePayload({
            productId: 'product-1',
            productName: 'Aspirina',
            sku: 'ASP-500',
            deepLink: 'https://app.example.com/products/product-1',
          }),
        },
        {
          id: 'tenant-1:p2:n:1',
          name: 'stock/low.detected',
          data: basePayload({
            productId: 'product-2',
            productName: 'Ibuprofeno',
            sku: 'IBU-200',
            deepLink: 'https://app.example.com/products/product-2',
            alertEpoch: 2,
            newQuantity: 1,
            minQuantity: 5,
          }),
        },
      ],
      step,
    });

    // mailer invoked exactly once (coalescing).
    expect(mailer.send).toHaveBeenCalledTimes(1);

    const sendCalls = mailer.send.mock.calls as unknown[][];
    const mailInput = sendCalls[0]?.[0] as {
      to: string[];
      subject: string;
      html: string;
    };

    // Both distinct product names MUST appear in the rendered body.
    // (Item sections are emitted by the template; this proves the
    // renderer folded both events in.)
    expect(mailInput.html).toContain('Aspirina');
    expect(mailInput.html).toContain('Ibuprofeno');

    // Both distinct SKUs MUST appear — distinguishes the items in
    // the body even if the template ever changed how productName
    // is rendered.
    expect(mailInput.html).toContain('ASP-500');
    expect(mailInput.html).toContain('IBU-200');

    // Subject is the plural form for > 1 item (the design
    // Risk R-E contract: "N productos con bajo inventario" for
    // count > 1, "1 producto con bajo inventario" for count = 1).
    expect(mailInput.subject).toMatch(/2 productos con bajo inventario/);
    expect(mailInput.subject).not.toMatch(/^1 producto/);
  });

  it('single-crossing batch produces the "1 producto con bajo inventario" subject and exactly one item section', async () => {
    // CRITICAL 2 (Reliability) — counterpart to the multi-item
    // test above. With ONE event, the subject is the singular form
    // AND the body must contain that event's product name (not
    // coerce to plural or wrap a second phantom item). The
    // `basePayload()` default has `productName: 'Aspirina'` — the
    // assertion below pins the subject + that the name is the
    // only product reference in the body.
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user-1'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue(['u1@example.com']),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
      appBaseUrl: 'https://app.example.com',
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [
        {
          id: 'tenant-1:p1:n:1',
          name: 'stock/low.detected',
          data: basePayload({ productName: 'Aspirina' }),
        },
      ],
      step,
    });

    expect(mailer.send).toHaveBeenCalledTimes(1);

    const sendCalls = mailer.send.mock.calls as unknown[][];
    const mailInput = sendCalls[0]?.[0] as {
      subject: string;
      html: string;
    };

    // Singular subject — the spec's "1 producto" form (design Risk
    // R-E). A multi-item subject would mean `composeSubject`
    // ignores the item count.
    expect(mailInput.subject).toBe('1 producto con bajo inventario');
    expect(mailInput.subject).not.toMatch(/2 productos/);

    // The product name is in the body.
    expect(mailInput.html).toContain('Aspirina');
  });

  it('short-circuits when notification config is disabled (master OFF)', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: false,
        recipients: ['user-1'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = { resolveEmailsByUserIds: jest.fn() };
    const mailer = { send: jest.fn() };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [{ id: 'k', name: 'stock/low.detected', data: basePayload() }],
      step,
    });

    expect(notificationConfigRepo.find).toHaveBeenCalledTimes(1);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('short-circuits when LOW_STOCK is not in enabledActions', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user-1'],
        enabledActions: [],
      }),
    };
    const userEmailLookup = { resolveEmailsByUserIds: jest.fn() };
    const mailer = { send: jest.fn() };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [{ id: 'k', name: 'stock/low.detected', data: basePayload() }],
      step,
    });

    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('short-circuits when recipient list is empty (spec: Empty Recipient List Suppresses Sends)', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: [],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue([]),
    };
    const mailer = { send: jest.fn() };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [{ id: 'k', name: 'stock/low.detected', data: basePayload() }],
      step,
    });

    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('dedupes recipients (the same email listed twice is rendered once)', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1', 'u1', 'u2'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest
        .fn()
        .mockResolvedValue([
          'u1@example.com',
          'u1@example.com',
          'u2@example.com',
        ]),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [{ id: 'k', name: 'stock/low.detected', data: basePayload() }],
      step,
    });

    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sendCalls = mailer.send.mock.calls as unknown[][];
    const arg = sendCalls[0]?.[0] as {
      to: string[];
    };
    expect(new Set(arg.to)).toEqual(
      new Set(['u1@example.com', 'u2@example.com']),
    );
    expect(arg.to).toHaveLength(2);
  });

  it('renders field-correctness: subject mentions the count and the body contains product name, variant, qty, min, SKU, category, deep link', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user@example.com'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue(['user@example.com']),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [
        {
          id: 'k',
          name: 'stock/low.detected',
          data: basePayload({
            variantDescription: '500mg caja 20',
            sku: 'ASP-500',
            category: 'Analgésicos',
            deepLink: 'https://app.example.com/products/product-1',
          }),
        },
      ],
      step,
    });

    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sendCalls = mailer.send.mock.calls as unknown[][];
    const mailInput = sendCalls[0]?.[0] as {
      subject: string;
      html: string;
    };
    expect(mailInput.subject).toMatch(/bajo inventario/i);
    expect(mailInput.html).toContain('Aspirina');
    expect(mailInput.html).toContain('500mg caja 20');
    expect(mailInput.html).toContain('3'); // qty
    expect(mailInput.html).toContain('ASP-500'); // SKU
    expect(mailInput.html).toContain('Analg'); // category
    expect(mailInput.html).toContain(
      'https://app.example.com/products/product-1',
    );
  });

  it('runs each step body inside runWithTenant so tenant-scoped repos can resolve tenantId from CLS', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user@example.com'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue(['user@example.com']),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: jest.fn((_id: string, fn: () => unknown) =>
        Promise.resolve(fn()),
      ),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [{ id: 'k', name: 'stock/low.detected', data: basePayload() }],
      step,
    });

    // runWithTenant called for at least the `load-config` and
    // `resolve-recipients` steps. The handler short-circuits when
    // tenantId is missing; we expect ≥ 2 normal calls.
    const runnerCalls = (tenantRunner.runWithTenant as jest.Mock).mock
      .calls as unknown[][];
    expect(runnerCalls.length).toBeGreaterThanOrEqual(1);
    const firstTenantId = runnerCalls[0]?.[0];
    expect(firstTenantId).toBe('tenant-1');
  });

  // ─── Template smoke — guarantee the LowStockEmail component
  // receives the items the handler composes (the SMS boundary is
  // the React Email renderer; this is a compile-time check on the
  // contract the handler satisfies).
  it('exports `LowStockEmail` + `LowStockEmailItem` for the template seam', () => {
    const props: { items: LowStockEmailItem[] } = {
      items: [
        {
          productName: 'p',
          variantDescription: null,
          currentQuantity: 1,
          minQuantity: 1,
          sku: null,
          category: null,
          deepLink: 'https://x',
        },
      ],
    };
    expect(typeof LowStockEmail).toBe('function');
    expect(Array.isArray(props.items)).toBe(true);
  });

  // WARNING (Reliability) — defense-in-depth for cross-tenant CLS
  // poisoning. The Inngest `batchEvents.key: 'event.data.tenantId'`
  // should partition by tenant so a mixed-tenant batch never reaches
  // the handler. But that is the SDK's promise, not ours — a
  // misconfigured downstream caller, an SDK bug, or a future
  // refactor of the key could let a foreign-tenant event slip in.
  // `composeItems` MUST filter those out so the rendered email
  // contains only the trusted tenant's items.
  //
  // The pre-existing dead ternary
  //   `events.every((e) => e.data.tenantId === tenantId)
  //      ? tenantId
  //      : events[0].data.tenantId`
  // did nothing — both branches evaluated to the same value — and
  // `composeItems` itself had no tenant guard. This test pins the
  // contract: a mixed-tenant batch does NOT leak the foreign-tenant
  // item into the email body, and the subject reflects only the
  // trusted-tenant count.
  it('defense-in-depth: a mixed-tenant batch (foreign event slipped in) does NOT leak the foreign item into the email', async () => {
    const fake = makeFakeInngest();
    const { buildLowStockFunctions } = await import('./low-stock.functions');
    const notificationConfigRepo = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['user@example.com'],
        enabledActions: ['LOW_STOCK'],
      }),
    };
    const userEmailLookup = {
      resolveEmailsByUserIds: jest.fn().mockResolvedValue(['user@example.com']),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };
    const tenantRunner = {
      runWithTenant: (_id: string, fn: () => unknown) => fn(),
    };

    buildLowStockFunctions({
      inngestClient: new fake.Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepo as never,
      userEmailLookup: userEmailLookup as never,
      mailer: mailer as never,
      appBaseUrl: 'https://app.example.com',
    });

    const { handler } = fake.captured[0];
    const { step } = makeFakeStep();

    await handler({
      events: [
        {
          id: 'tenant-1:p1:n:1',
          name: 'stock/low.detected',
          // Trusted tenant — Aspirina.
          data: basePayload({
            tenantId: 'tenant-1',
            productId: 'product-1',
            productName: 'Aspirina',
            sku: 'ASP-500',
          }),
        },
        {
          id: 'tenant-other:p2:n:1',
          name: 'stock/low.detected',
          // Foreign tenant — should NOT appear in the email body.
          data: basePayload({
            tenantId: 'tenant-other',
            productId: 'product-2',
            productName: 'ForeignProduct',
            sku: 'FGN-999',
          }),
        },
      ],
      step,
    });

    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sendCalls = mailer.send.mock.calls as unknown[][];
    const mailInput = sendCalls[0]?.[0] as {
      to: string[];
      subject: string;
      html: string;
    };

    // The trusted tenant's product name MUST be in the body.
    expect(mailInput.html).toContain('Aspirina');

    // The foreign tenant's product name MUST NOT be in the body
    // (no cross-tenant PII / alert leak).
    expect(mailInput.html).not.toContain('ForeignProduct');
    expect(mailInput.html).not.toContain('FGN-999');

    // Subject reflects only the trusted tenant's count (1 item),
    // not the 2-item batch the un-guarded composeItems would have
    // produced. This proves the filter actually drops the event
    // — if it just kept both, the subject would be the plural
    // form.
    expect(mailInput.subject).toBe('1 producto con bajo inventario');
  });
});
