/**
 * pca-5b — safe test-only AppModule boot proof for the promotion capacity
 * and expiry alert pipeline.
 *
 * ## Why this harness exists
 *
 * `pca-3b3b` / `pca-3b4c` / `pca-3c4c` each proved their own slice with
 * mocked DI and a "direct test-only Nest DI compile" (`NEST_DI_COMPILE_OK`).
 * A DI compile never runs `onModuleInit` / `onApplicationBootstrap`, so no
 * slice ever observed the ONE runtime fact that matters for delivery:
 * that the registrar hooks really execute and that `InngestController`
 * snapshots a `serve()` handler containing exactly one
 * `promotion-near-capacity-email` and exactly one `promotion-expiring-email`
 * function. This spec closes that gap with a real `AppModule` boot.
 *
 * ## Why it is safe (and why a plain `AppModule.init()` is not)
 *
 * Booting `AppModule` unmocked would, at boot:
 *   1. `PrismaService.onModuleInit` → a real `$connect` to `DATABASE_URL`.
 *   2. `PermissionSeeder.onApplicationBootstrap` → real permission/role
 *      upserts (DB writes).
 *   3. `PdfGenerationService.onModuleInit` → font registration that
 *      pre-flights a CDN (external network).
 *   4. Seven `@Interval` pollers/scanners → real timers that poll the DB
 *      every few seconds.
 *
 * This harness replaces exactly those four boundaries with inert test
 * doubles and proves the replacements are the instances actually bound in
 * the container (`toBe` identity), that no provider instance is an
 * instance of a replaced class, and that the `SchedulerRegistry` ends the
 * boot with zero intervals/timeouts/cron jobs.
 *
 * ## Fail-closed lifecycle guard
 *
 * Before `init()` runs any hook, the harness enumerates every provider and
 * controller in the compiled container and rejects any boot-hook owner
 * (`onModuleInit` / `onApplicationBootstrap`) that is not on the reviewed
 * allowlist below. A newly wired, unbounded lifecycle hook fails this spec
 * with its class name instead of silently running side effects.
 *
 * ## Safety boundaries of this harness
 *
 *   - No real DB connection: `PrismaService` is replaced by an inert stub
 *     whose `$connect` / `$transaction` are asserted uncalled, and the
 *     stub deliberately exposes NO model delegate — any boot-time query
 *     becomes a loud `TypeError` instead of a silent roundtrip.
 *   - No seeder writes: the real `PermissionSeeder` is not in the graph.
 *   - No interval/timer: `SchedulerRegistry` must be empty after boot.
 *   - No outbound mail or event: `IMailer.send` and `InngestService.send`
 *     are spied with non-network implementations and asserted uncalled.
 *   - No real credentials: every Joi-required key is overwritten with a
 *     fake value before `AppModule` is imported, so a developer `.env` can
 *     never leak a productive secret into this boot.
 *
 * ## Why the env is seeded before the dynamic import
 *
 * `ConfigModule.forRoot()` validates its Joi schema when it is CALLED, and
 * `app.module.ts` calls it while the module file is evaluated. A static
 * `import { AppModule } from '../app.module'` would therefore validate the
 * schema (and reject its promise) before a single `process.env` write in
 * this file could run. The import is deferred into the test body and runs
 * after `applyFakeEnv()`.
 *
 * ## Why the `src/products/products.service` virtual mock
 *
 * `src/orders/listeners/order-event.listener.ts` imports `ProductsService`
 * through a bare-root specifier (`'src/products/products.service'`) that
 * neither `tsconfig.json` (`baseUrl` only, no `paths`) nor Jest's resolver
 * maps. Without the virtual mock, `AppModule` cannot even be loaded in
 * Jest. The factory re-exports the REAL module so the DI token stays
 * identical to the one `ProductsModule` provides — a fabricated class
 * would break `OrderEventListener`'s constructor injection.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DiscoveryService } from '@nestjs/core';
import { PrismaService } from '../shared/prisma/prisma.service';
import { PermissionSeeder } from '../auth/authorization/infrastructure/permission.seeder';
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { OutboxPollerService } from '../shared/outbox/outbox-poller.service';
import { LowStockOutboxPoller } from '../stock-alerts/outbox/low-stock-outbox.poller';
import { DeliveryRoutesOutboxPoller } from '../delivery-routes/outbox/delivery-routes-outbox.poller';
import { HrTimeOffOutboxPoller } from '../hr-time-off/outbox/hr-time-off-outbox.poller';
import { PromotionCapacityOutboxPoller } from '../promotions/outbox/promotion-capacity-outbox.poller';
import { PromotionExpiryOutboxPoller } from '../promotions/outbox/promotion-expiry-outbox.poller';
import { PromotionExpiryScanner } from '../promotions/expiry/promotion-expiry.scanner';
import { InngestService } from './inngest.service';
import { MAILER, type IMailer } from '../notifications/email/mailer.port';

/** Inngest function ids owned by the promotion alert delivery path. */
const NEAR_CAPACITY_FUNCTION_ID = 'promotion-near-capacity-email';
const EXPIRING_FUNCTION_ID = 'promotion-expiring-email';
const DELIVERY_THANK_YOU_FUNCTION_ID = 'delivery-thank-you-notify';

/**
 * A full `AppModule` boot instantiates a few hundred providers through
 * ts-jest's type-checking transform. The default 5s Jest timeout is not a
 * safety boundary here (the harness fails closed on the lifecycle
 * inventory, not on time), so it is raised explicitly instead of hiding a
 * flake: a hang still fails the run, just later.
 */
const BOOT_TIMEOUT_MS = 180_000;

// ───────────────────────────────────────────────────────────────────────
// Hoisted module mocks
// ───────────────────────────────────────────────────────────────────────

/** The option bag `serve()` receives from `InngestController`. */
interface InngestServeOptions {
  client: unknown;
  functions: unknown;
  signingKey?: string;
}

type ExpressMiddleware = (req: unknown, res: unknown, next?: unknown) => void;

interface CapturedServeCall {
  options: InngestServeOptions;
  middleware: ExpressMiddleware;
}

/**
 * Every `serve()` invocation during the boot. `InngestController` memoizes
 * the handler in `onApplicationBootstrap`, so a healthy boot produces
 * exactly one entry with the full registered function list.
 */
const mockServeCalls: CapturedServeCall[] = [];

jest.mock('inngest/express', () => ({
  serve: (options: InngestServeOptions): ExpressMiddleware => {
    // The handler body is never executed here: this harness observes the
    // registration snapshot, it does not dispatch HTTP requests.
    const middleware: ExpressMiddleware = (): void => undefined;
    mockServeCalls.push({ options, middleware });
    return middleware;
  },
}));

// Bare-root import compatibility (see the file header). Re-exporting the
// real module keeps the DI token identical to ProductsModule's.
jest.mock(
  'src/products/products.service',
  () =>
    jest.requireActual<typeof import('../products/products.service')>(
      '../products/products.service',
    ),
  { virtual: true },
);

// ───────────────────────────────────────────────────────────────────────
// Fake environment (seeded BEFORE AppModule is imported)
// ───────────────────────────────────────────────────────────────────────

/**
 * Fake values for every Joi-required key in
 * `buildEnvValidationSchema()`. No value here is a real credential: the
 * point is that a populated developer `.env` cannot shadow them (Jest's
 * `process.env` wins over dotenv, which never overrides existing keys).
 */
const FAKE_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  // Points at a closed port on purpose: if anything ever dials it, the
  // test double was bypassed and the boot is not the one we proved.
  DATABASE_URL: 'postgresql://pca5-fake:pca5-fake@127.0.0.1:1/pca5-no-connect',
  JWT_SECRET: 'pca-5-harness-fake-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'pca-5-harness-fake-refresh-secret-0123456789',
  JWT_ACCESS_EXPIRATION: '15m',
  JWT_REFRESH_EXPIRATION: '7d',
  SPACES_ENDPOINT: 'https://spaces.invalid',
  SPACES_REGION: 'pca5-region',
  SPACES_BUCKET: 'pca5-test-bucket',
  SPACES_ACCESS_KEY_ID: 'pca5-fake-access-key-id',
  SPACES_SECRET_ACCESS_KEY: 'pca5-fake-secret-access-key',
  SPACES_PUBLIC_BASE_URL: 'https://cdn.invalid',
  SPACES_UPLOAD_MAX_MB: '10',
  INNGEST_SIGNING_KEY: 'pca5-fake-signing-key',
  INNGEST_EVENT_KEY: 'pca5-fake-event-key',
  RESEND_API_KEY: 'pca5-fake-resend-key',
  MAIL_FROM: 'pca5 harness <pca5@example.invalid>',
  APP_WEB_URL: 'https://app.invalid',
};

function applyFakeEnv(): void {
  for (const [key, value] of Object.entries(FAKE_ENV)) {
    process.env[key] = value;
  }
  // `INNGEST_DEV` must be ABSENT in this harness: a leftover truthy value
  // from a developer shell would flip the SDK to dev mode.
  delete process.env.INNGEST_DEV;
}

// ───────────────────────────────────────────────────────────────────────
// Inert test doubles
// ───────────────────────────────────────────────────────────────────────

const mockPrismaConnect = jest.fn<Promise<void>, []>();
const mockPrismaDisconnect = jest.fn<Promise<void>, []>();
const mockPrismaTransaction = jest.fn<Promise<unknown>, [unknown]>();
const mockPrismaExtends = jest.fn<unknown, [unknown]>();
const mockPrismaOnModuleDestroy = jest.fn<Promise<void>, []>();

const mockPermissionSeederBootstrap = jest.fn<void, []>();
const mockPdfFontRegistration = jest.fn<Promise<void>, []>();

/**
 * Inert `PrismaService` double.
 *
 * An explicit, closed-shape object (NOT a catch-all `Proxy`). A `Proxy`
 * whose `get` trap fabricated and STORED a `jest.fn()` per property read
 * was measured to hang `compile()` of the full `AppModule` (bisected: the
 * full import list, the full `AppModule`, and a plain-object override all
 * compile in <70 ms, while only the `Proxy` override never settled). This
 * stub keeps a fixed shape, and — deliberately — exposes no model
 * delegates: `this.prisma.product.findMany(...)` at boot would throw a
 * `TypeError` (loud failure of the DB boundary) instead of silently
 * issuing a query. Every property it does expose is asserted uncalled
 * below.
 *
 * `$extends` returns the stub itself, mirroring the real contract where
 * `$extends` returns a usable client (`tenant-prisma.factory.ts`).
 */
function createPrismaStub(): PrismaService {
  const stub: Record<string, unknown> = {
    $connect: mockPrismaConnect,
    $disconnect: mockPrismaDisconnect,
    $transaction: mockPrismaTransaction,
    $extends: mockPrismaExtends,
    // Present so `tenant-prisma.service.ts`'s `'$extends' in txClient`
    // probe answers truthfully for the lazily built tenant client.
    $on: jest.fn(),
    onModuleDestroy: mockPrismaOnModuleDestroy,
  };

  mockPrismaExtends.mockReturnValue(stub);
  return stub as unknown as PrismaService;
}

/**
 * Inert stand-in for a `@Interval`-decorated poller/scanner.
 *
 * Deliberately a plain object with no prototype methods: `ScheduleExplorer`
 * scans provider instances for `@Interval` metadata, so an object without
 * the decorated method cannot register a timer. Nothing at boot calls the
 * pollers' methods.
 */
function createInertPollerStub(): Record<string, never> {
  return {};
}

// ───────────────────────────────────────────────────────────────────────
// Fail-closed lifecycle inventory
// ───────────────────────────────────────────────────────────────────────

type BootHookName = 'onModuleInit' | 'onApplicationBootstrap';

const BOOT_HOOK_NAMES: readonly BootHookName[] = [
  'onModuleInit',
  'onApplicationBootstrap',
];

interface BootHookOwner {
  /** Every name this owner is known by: DI token name, class name, ctor. */
  names: string[];
  hooks: string[];
  instance: unknown;
}

/**
 * Reviewed allowlist for boot-hook owners in this container.
 *
 *   - `inert-stub` → the owner MUST be the test double (`toBe` identity).
 *   - `wiring`     → required for this proof, and reviewed as side-effect
 *     free at boot (Inngest function registration, the `serve()` snapshot,
 *     CASL subject-resolver registration, `@nestjs/schedule` and
 *     `nestjs-cls` / `@nestjs/event-emitter` in-memory registries).
 *
 * Anything else means a new unbounded lifecycle hook reached `AppModule`;
 * the guard fails BEFORE `init()` so its side effects never run.
 */
const ALLOWED_BOOT_HOOK_OWNERS: ReadonlyMap<string, 'inert-stub' | 'wiring'> =
  new Map([
    ['PermissionSeeder', 'inert-stub'],
    ['PdfGenerationService', 'inert-stub'],
    ['InngestController', 'wiring'],
    ['LowStockInngestRegistrar', 'wiring'],
    ['HrTimeOffInngestRegistrar', 'wiring'],
    ['DeliveryRoutesInngestRegistrar', 'wiring'],
    // DTE-4e: constructs an inert sender and registers a local SDK function;
    // it never reads DB, dispatches an event or invokes the injected mailer.
    ['DeliveryThankYouInngestRegistrar', 'wiring'],
    ['PromotionCapacityInngestRegistrar', 'wiring'],
    ['PromotionExpiryInngestRegistrar', 'wiring'],
    ['DeliveryRouteSubjectResolverRegistrar', 'wiring'],
    // @nestjs/schedule: interval exploration + in-process timer mounting.
    ['ScheduleExplorer', 'wiring'],
    ['SchedulerOrchestrator', 'wiring'],
    // @nestjs/event-emitter: in-memory @OnEvent subscriber registration.
    ['EventSubscribersLoader', 'wiring'],
    // nestjs-cls: in-memory proxy-provider manager + plugin hook collection
    // (the HTTP `configure()` middleware mount never runs in a TestingModule).
    ['ClsRootModule', 'wiring'],
    ['ClsPluginsHooksHost', 'wiring'],
  ]);

function bootHooksOf(instance: unknown): string[] {
  if (instance === null || typeof instance !== 'object') return [];
  return BOOT_HOOK_NAMES.filter(
    (hook) => typeof (instance as Record<string, unknown>)[hook] === 'function',
  );
}

/**
 * All names an owner can be matched by. DI tokens and instances diverge for
 * value/factory providers (a `useValue` stub reports `Object` as its
 * constructor while its DI token stays the replaced class), so the guard
 * matches on token name, class name AND constructor name.
 */
function ownerNamesOf(
  wrapper: { name?: unknown; metatype?: unknown },
  instance: unknown,
): string[] {
  const names = new Set<string>();
  const tokenName = wrapper.name;
  if (typeof tokenName === 'string' && tokenName.length > 0) {
    names.add(tokenName);
  }
  const className = (instance as { constructor?: { name?: unknown } })
    ?.constructor?.name;
  if (typeof className === 'string' && className.length > 0) {
    names.add(className);
  }
  const metatypeName = (wrapper.metatype as { name?: unknown })?.name;
  if (typeof metatypeName === 'string' && metatypeName.length > 0) {
    names.add(metatypeName);
  }
  return [...names];
}

/**
 * Collect every provider/controller instance in the compiled container
 * that exposes a boot hook. Runs after `compile()` (instances exist) and
 * before `init()` (hooks have not run yet).
 */
function collectBootHookOwners(moduleRef: TestingModule): BootHookOwner[] {
  const discovery = moduleRef.get(DiscoveryService, { strict: false });
  const wrappers = [...discovery.getProviders(), ...discovery.getControllers()];

  const owners: BootHookOwner[] = [];
  for (const wrapper of wrappers) {
    const instance: unknown = wrapper.instance;
    const hooks = bootHooksOf(instance);
    if (hooks.length === 0) continue;
    owners.push({ names: ownerNamesOf(wrapper, instance), hooks, instance });
  }
  return owners;
}

/**
 * Fail-closed guard: throws (so `init()` is never reached) when an
 * unreviewed boot hook is present, and asserts the inert stubs are the
 * instances actually bound for the owners they replace.
 */
function assertBootHooksAreBounded(
  owners: BootHookOwner[],
  inertStubs: ReadonlyMap<string, unknown>,
): void {
  const classified = owners.map((owner) => ({
    owner,
    matched: owner.names.filter((name) => ALLOWED_BOOT_HOOK_OWNERS.has(name)),
  }));

  const unexpected = classified.filter((entry) => entry.matched.length === 0);
  if (unexpected.length > 0) {
    throw new Error(
      `pca-5b fail-closed: ${unexpected.length} unreviewed boot lifecycle hook owner(s) found: ` +
        unexpected
          .map(
            (entry) =>
              `[${entry.owner.names.join('/')}](${entry.owner.hooks.join(',')})`,
          )
          .join(', ') +
        '. Stub them or add them to ALLOWED_BOOT_HOOK_OWNERS after review — this ' +
        'harness must never run an unbounded boot hook (DB/network/timer side effects).',
    );
  }

  for (const entry of classified) {
    const isInertStub = entry.matched.some(
      (name) => ALLOWED_BOOT_HOOK_OWNERS.get(name) === 'inert-stub',
    );
    if (!isInertStub) continue;
    const stub = entry.matched
      .map((name) => inertStubs.get(name))
      .find((candidate) => candidate !== undefined);
    expect(entry.owner.instance).toBe(stub);
  }
}

/**
 * Extract one Inngest function id.
 *
 * The Inngest v4 SDK does NOT store the id as a string property: the
 * registered object exposes `id()` as a METHOD and the raw value inside
 * `opts.id`. Reading `fn.id` as a string silently yields zero ids (which
 * would make a "no duplicate ids" assertion vacuously true), so all three
 * shapes are handled explicitly.
 */
function inngestIdOf(fn: unknown): string | null {
  if (fn === null || typeof fn !== 'object') return null;
  const candidate = (fn as { id?: unknown }).id;
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate === 'function') {
    const value: unknown = (candidate as () => unknown).call(fn);
    return typeof value === 'string' ? value : null;
  }
  const optsId = (fn as { opts?: { id?: unknown } }).opts?.id;
  return typeof optsId === 'string' ? optsId : null;
}

/** Extract every function id from the entries handed to `serve()`. */
function functionIdsOf(functions: unknown): string[] {
  if (!Array.isArray(functions)) {
    throw new Error(
      `pca-5b: serve() did not receive an array of functions (got ${typeof functions}).`,
    );
  }
  return functions
    .map((fn: unknown) => inngestIdOf(fn))
    .filter((id): id is string => id !== null);
}

// ───────────────────────────────────────────────────────────────────────

describe('pca-5b — promotion alert AppModule boot proof (test-only, stubbed boundaries)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it(
    'boots AppModule and snapshots one promotion-near-capacity-email + one promotion-expiring-email in the Inngest serve handler',
    async () => {
      // 1. Fake env FIRST — ConfigModule.forRoot validates at import time.
      applyFakeEnv();

      const prismaStub = createPrismaStub();
      const permissionSeederStub = {
        onApplicationBootstrap: mockPermissionSeederBootstrap,
      };
      const pdfGenerationStub = { onModuleInit: mockPdfFontRegistration };
      const pollerStubs = {
        [OutboxPollerService.name]: createInertPollerStub(),
        [LowStockOutboxPoller.name]: createInertPollerStub(),
        [DeliveryRoutesOutboxPoller.name]: createInertPollerStub(),
        [HrTimeOffOutboxPoller.name]: createInertPollerStub(),
        [PromotionCapacityOutboxPoller.name]: createInertPollerStub(),
        [PromotionExpiryOutboxPoller.name]: createInertPollerStub(),
        [PromotionExpiryScanner.name]: createInertPollerStub(),
      };

      let moduleRef: TestingModule | undefined;
      try {
        // 2. Deferred import: the Joi schema now validates fake values only.
        const { AppModule } = await import('../app.module');

        // 3. Compile the REAL application graph with the four dangerous
        //    boundaries replaced (no DB connect, no seeder writes, no font
        //    CDN, no timers).
        moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(PrismaService)
          .useValue(prismaStub)
          .overrideProvider(PermissionSeeder)
          .useValue(permissionSeederStub)
          .overrideProvider(PdfGenerationService)
          .useValue(pdfGenerationStub)
          .overrideProvider(OutboxPollerService)
          .useValue(pollerStubs[OutboxPollerService.name])
          .overrideProvider(LowStockOutboxPoller)
          .useValue(pollerStubs[LowStockOutboxPoller.name])
          .overrideProvider(DeliveryRoutesOutboxPoller)
          .useValue(pollerStubs[DeliveryRoutesOutboxPoller.name])
          .overrideProvider(HrTimeOffOutboxPoller)
          .useValue(pollerStubs[HrTimeOffOutboxPoller.name])
          .overrideProvider(PromotionCapacityOutboxPoller)
          .useValue(pollerStubs[PromotionCapacityOutboxPoller.name])
          .overrideProvider(PromotionExpiryOutboxPoller)
          .useValue(pollerStubs[PromotionExpiryOutboxPoller.name])
          .overrideProvider(PromotionExpiryScanner)
          .useValue(pollerStubs[PromotionExpiryScanner.name])
          .compile();

        // 4. Fail-closed BEFORE any hook runs.
        assertBootHooksAreBounded(
          collectBootHookOwners(moduleRef),
          new Map<string, unknown>([
            ['PermissionSeeder', permissionSeederStub],
            ['PdfGenerationService', pdfGenerationStub],
          ]),
        );

        // 5. The stubs must be the instances actually bound (an
        //    `overrideProvider` for an absent token is a silent no-op in
        //    Nest, so identity is the real proof).
        expect(moduleRef.get(PrismaService, { strict: false })).toBe(
          prismaStub,
        );
        expect(moduleRef.get(PermissionSeeder, { strict: false })).toBe(
          permissionSeederStub,
        );
        expect(moduleRef.get(PdfGenerationService, { strict: false })).toBe(
          pdfGenerationStub,
        );
        expect(moduleRef.get(OutboxPollerService, { strict: false })).toBe(
          pollerStubs[OutboxPollerService.name],
        );
        expect(moduleRef.get(LowStockOutboxPoller, { strict: false })).toBe(
          pollerStubs[LowStockOutboxPoller.name],
        );
        expect(
          moduleRef.get(DeliveryRoutesOutboxPoller, { strict: false }),
        ).toBe(pollerStubs[DeliveryRoutesOutboxPoller.name]);
        expect(moduleRef.get(HrTimeOffOutboxPoller, { strict: false })).toBe(
          pollerStubs[HrTimeOffOutboxPoller.name],
        );
        expect(
          moduleRef.get(PromotionCapacityOutboxPoller, { strict: false }),
        ).toBe(pollerStubs[PromotionCapacityOutboxPoller.name]);
        expect(
          moduleRef.get(PromotionExpiryOutboxPoller, { strict: false }),
        ).toBe(pollerStubs[PromotionExpiryOutboxPoller.name]);
        expect(moduleRef.get(PromotionExpiryScanner, { strict: false })).toBe(
          pollerStubs[PromotionExpiryScanner.name],
        );

        // 6. Outbound boundaries: spied with non-network implementations so
        //    an accidental dispatch cannot reach Inngest or Resend, and the
        //    "not called" assertion becomes proof of no outbound traffic.
        const inngestService = moduleRef.get(InngestService, { strict: false });
        const sendSpy = jest
          .spyOn(inngestService, 'send')
          .mockResolvedValue({ ids: [] });
        const mailer = moduleRef.get<IMailer>(MAILER, { strict: false });
        const mailSpy = jest.spyOn(mailer, 'send').mockResolvedValue(undefined);

        // 7. THE BOOT. Runs onModuleInit (registrars) + onApplicationBootstrap
        //    (serve() snapshot, schedule orchestration).
        await moduleRef.init();

        // 8. Runtime observation: exactly one serve() snapshot, exactly one
        //    registration per promotion alert function, no duplicate ids.
        expect(mockServeCalls).toHaveLength(1);
        const captured = mockServeCalls[0];
        const ids = functionIdsOf(captured.options.functions);
        // Guard against a vacuous pass: if id extraction ever stops working,
        // the "exactly one each" assertions below would fail anyway, but this
        // makes the failure say WHY.
        expect(ids.length).toBeGreaterThan(0);

        expect(
          ids.filter((id) => id === NEAR_CAPACITY_FUNCTION_ID),
        ).toHaveLength(1);
        expect(ids.filter((id) => id === EXPIRING_FUNCTION_ID)).toHaveLength(1);
        expect(
          ids.filter((id) => id === DELIVERY_THANK_YOU_FUNCTION_ID),
        ).toHaveLength(1);
        expect(new Set(ids).size).toBe(ids.length);
        expect(captured.options.client).toBe(inngestService.getClient());
        expect(typeof captured.middleware).toBe('function');

        // The registrar hooks really ran: the service registry the serve()
        // snapshot was built from is populated, and the controller
        // snapshotted the same list.
        const registered = inngestService.getFunctions();
        expect(registered).toHaveLength(ids.length);
        expect(inngestService.getClientId()).toBe('houndfe-backend');

        // 9. No timer was mounted by any @Interval poller/scanner.
        const schedulerRegistry = moduleRef.get(SchedulerRegistry, {
          strict: false,
        });
        expect(schedulerRegistry.getIntervals()).toEqual([]);
        expect(schedulerRegistry.getTimeouts()).toEqual([]);
        expect(schedulerRegistry.getCronJobs().size).toBe(0);

        // 10. No DB, no seeder work, no mail, no event.
        expect(mockPrismaConnect).not.toHaveBeenCalled();
        expect(mockPrismaTransaction).not.toHaveBeenCalled();
        expect(mockPermissionSeederBootstrap).toHaveBeenCalledTimes(1);
        expect(sendSpy).not.toHaveBeenCalled();
        expect(mailSpy).not.toHaveBeenCalled();

        // 11. No instance of a replaced class is live anywhere in the graph —
        //     the real PrismaService/seeder/PDF service/pollers were never
        //     constructed.
        const discovery = moduleRef.get(DiscoveryService, { strict: false });
        const instances: unknown[] = [
          ...discovery.getProviders(),
          ...discovery.getControllers(),
        ].map((wrapper) => wrapper.instance as unknown);
        expect(
          instances.filter((instance) => instance instanceof PrismaService),
        ).toHaveLength(0);
        expect(
          instances.filter((instance) => instance instanceof PermissionSeeder),
        ).toHaveLength(0);
        expect(
          instances.filter(
            (instance) => instance instanceof PdfGenerationService,
          ),
        ).toHaveLength(0);
        expect(
          instances.filter(
            (instance) => instance instanceof OutboxPollerService,
          ),
        ).toHaveLength(0);
        expect(
          instances.filter(
            (instance) =>
              instance instanceof PromotionExpiryScanner ||
              instance instanceof PromotionCapacityOutboxPoller ||
              instance instanceof PromotionExpiryOutboxPoller ||
              instance instanceof LowStockOutboxPoller ||
              instance instanceof DeliveryRoutesOutboxPoller ||
              instance instanceof HrTimeOffOutboxPoller,
          ),
        ).toHaveLength(0);
      } finally {
        // 12. Clean close even when an assertion above failed.
        if (moduleRef) {
          await moduleRef.close();
        }
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
