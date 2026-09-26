/**
 * Spec — DeliveryThankYouInngestRegistrar / DTE-4e.registration.
 *
 * Proves the boot-time registration lifecycle of the customer thank-you
 * delivery path WITHOUT a live database, mail provider or network:
 *
 *   - `onModuleInit` builds the `delivery-thank-you-notify` function and
 *     registers exactly ONE REAL Inngest SDK function (the object the real
 *     `InngestService` guard resolves by `id()`), with a distinct id from
 *     the sibling `delivery-next-stop-notify` function.
 *   - Registration touches no port: the mailer, the three delivery-routes
 *     sale ports, the notification-config repo and the tenant runner all
 *     stay untouched. The sender is only composed, never invoked.
 *   - A second wiring is rejected atomically by the real
 *     `InngestService.registerFunctions` duplicate guard, leaving the
 *     existing registry intact.
 *   - `AppModule` lists the registrar EXACTLY ONCE as a top-level provider
 *     (reflection over `MODULE_METADATA`, no DI boot).
 *
 * The `AppModule` import is deferred until after a fake `NODE_ENV=test`
 * environment is seeded, because `ConfigModule.forRoot()` validates its
 * Joi schema while the module file is evaluated. Static-importing
 * `app.module.ts` without those keys throws a `Config validation error`
 * before any test can run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';

// AppModule's transitive graph contains one bare-root import
// (`src/products/products.service`) that Jest cannot resolve without a
// `modulePaths`/`baseUrl` mapping. Register a virtual mock so the metadata
// assertion below can load AppModule without resolving that unrelated
// module. No DI boot happens, so the fabricated class is never injected.
jest.mock(
  'src/products/products.service',
  () => ({ ProductsService: class ProductsService {} }),
  { virtual: true },
);

import { InngestService } from '../../inngest/inngest.service';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import { type IMailer } from '../../notifications/email/mailer.port';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { ISaleCustomerEmailLookup } from '../domain/ports/sale-customer-email.port';
import type { ISaleDeliveryStopProvenance } from '../domain/ports/sale-delivery-stop-provenance.port';
import type { ISaleDeliverySummaryReader } from '../domain/ports/sale-delivery-summary.port';
import { buildDeliveryNextStopNotifyFunctions } from './delivery-next-stop-notify.functions';
import { DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID } from './delivery-thank-you-notify.functions';
import { DeliveryThankYouInngestRegistrar } from './delivery-thank-you-inngest-registrar';

/** Distinct id owned by the sibling next-stop registrar. */
const NEXT_STOP_FUNCTION_ID = 'delivery-next-stop-notify';

const EMPTY_CONFIG: NotificationConfigView = {
  enabled: false,
  recipients: [],
  enabledActions: [],
};

/** `id()` is a prototype method on the real Inngest v4 function. */
interface SdkFunctionWithId {
  id(prefix?: string): string;
}

function isSdkFunctionWithId(value: unknown): value is SdkFunctionWithId {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'function'
  );
}

/** Resolve a registered entry's id the way `serve()` would. */
function functionId(fn: unknown): string {
  if (!isSdkFunctionWithId(fn)) {
    throw new Error('registered entry is not a real SDK function (no id())');
  }
  return fn.id();
}

function makePorts() {
  const find = jest.fn<Promise<NotificationConfigView>, []>(() =>
    Promise.resolve(EMPTY_CONFIG),
  );
  const replace = jest.fn<
    Promise<NotificationConfigView>,
    [Parameters<INotificationConfigRepository['replace']>[0]]
  >(() => Promise.resolve(EMPTY_CONFIG));
  const notificationConfig: INotificationConfigRepository = { find, replace };

  const hasCompletedRouteStop = jest.fn<
    Promise<boolean>,
    [Parameters<ISaleDeliveryStopProvenance['hasCompletedRouteStop']>[0]]
  >(() => Promise.resolve(false));
  const stopProvenance: ISaleDeliveryStopProvenance = { hasCompletedRouteStop };

  const findConfirmedDeliveredSummary = jest.fn<
    Promise<
      Awaited<
        ReturnType<ISaleDeliverySummaryReader['findConfirmedDeliveredSummary']>
      >
    >,
    [Parameters<ISaleDeliverySummaryReader['findConfirmedDeliveredSummary']>[0]]
  >(() => Promise.resolve(null));
  const summaryReader: ISaleDeliverySummaryReader = {
    findConfirmedDeliveredSummary,
  };

  const findEmailBySaleId = jest.fn<
    Promise<string | null>,
    [Parameters<ISaleCustomerEmailLookup['findEmailBySaleId']>[0]]
  >(() => Promise.resolve(null));
  const customerEmailLookup: ISaleCustomerEmailLookup = { findEmailBySaleId };

  const send = jest.fn<Promise<void>, [Parameters<IMailer['send']>[0]]>(() =>
    Promise.resolve(undefined),
  );
  const mailer: IMailer = { send };

  return {
    notificationConfig,
    find,
    stopProvenance,
    hasCompletedRouteStop,
    summaryReader,
    findConfirmedDeliveredSummary,
    customerEmailLookup,
    findEmailBySaleId,
    mailer,
    send,
  };
}

// Fully in-memory DI: a REAL InngestService (its Inngest client is built
// offline and `createFunction` is pure JS), a REAL TenantRunnerService
// (with an inert AsyncLocalStorage), and cast-free port doubles.
function makeHarness() {
  const inngestService = new InngestService(
    new ConfigService({ NODE_ENV: 'test' }),
  );
  const tenantRunner = new TenantRunnerService(
    new ClsService<TenantClsStore>(new AsyncLocalStorage()),
  );
  const runWithTenant = jest.spyOn(tenantRunner, 'runWithTenant');
  const ports = makePorts();

  const registrar = new DeliveryThankYouInngestRegistrar(
    inngestService,
    ports.notificationConfig,
    ports.stopProvenance,
    ports.summaryReader,
    ports.customerEmailLookup,
    ports.mailer,
    tenantRunner,
  );

  return { registrar, inngestService, tenantRunner, runWithTenant, ...ports };
}

const FAKE_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://dte4e:dte4e@127.0.0.1:1/dte4e-no-connect',
  JWT_SECRET: 'dte4e-registration-fake-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'dte4e-registration-fake-refresh-secret-0123456789',
  SPACES_ENDPOINT: 'https://spaces.invalid',
  SPACES_REGION: 'dte4e-region',
  SPACES_BUCKET: 'dte4e-test-bucket',
  SPACES_ACCESS_KEY_ID: 'dte4e-fake-access-key-id',
  SPACES_SECRET_ACCESS_KEY: 'dte4e-fake-secret-access-key',
  SPACES_PUBLIC_BASE_URL: 'https://cdn.invalid',
};

async function appModuleProviders(): Promise<unknown[]> {
  const previous = { ...process.env };
  Object.assign(process.env, FAKE_ENV);
  try {
    const { AppModule } = await import('../../app.module');
    return Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    ) as unknown[];
  } finally {
    // ConfigModule.forRoot can add validated defaults beyond FAKE_ENV.
    // Restore the entire environment, including keys it introduced.
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

describe('DeliveryThankYouInngestRegistrar (DTE-4e.registration)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers exactly one real SDK function recognized by InngestService', () => {
    const h = makeHarness();

    h.registrar.onModuleInit();

    const registered = h.inngestService.getFunctions();
    expect(registered).toHaveLength(1);
    expect(functionId(registered[0])).toBe(
      DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
    );
    expect(DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID).toBe(
      'delivery-thank-you-notify',
    );
  });

  it('calls no mail or database port while registering', () => {
    const h = makeHarness();

    h.registrar.onModuleInit();

    expect(h.find).not.toHaveBeenCalled();
    expect(h.hasCompletedRouteStop).not.toHaveBeenCalled();
    expect(h.findConfirmedDeliveredSummary).not.toHaveBeenCalled();
    expect(h.findEmailBySaleId).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.runWithTenant).not.toHaveBeenCalled();
  });

  it('rejects a duplicate registration atomically and keeps the registry intact', () => {
    const h = makeHarness();
    h.registrar.onModuleInit();

    expect(() => h.registrar.onModuleInit()).toThrow(/duplicate function id/);

    const registered = h.inngestService.getFunctions();
    expect(registered).toHaveLength(1);
    expect(functionId(registered[0])).toBe(
      DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
    );
  });

  it('leaves the existing delivery-next-stop-notify registration and uses a distinct id', () => {
    const h = makeHarness();
    // Register the sibling function first, exactly as its own registrar
    // would at boot.
    h.inngestService.registerFunctions(
      buildDeliveryNextStopNotifyFunctions({
        inngestClient: h.inngestService.getClient(),
        tenantRunner: h.tenantRunner,
        notificationConfigRepository: h.notificationConfig,
        saleCustomerEmailLookup: h.customerEmailLookup,
        mailer: h.mailer,
      }),
    );

    h.registrar.onModuleInit();

    const ids = h.inngestService.getFunctions().map(functionId);
    expect(ids).toEqual([
      NEXT_STOP_FUNCTION_ID,
      DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
    ]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('provides DeliveryThankYouInngestRegistrar once as an AppModule provider', async () => {
    const providers = await appModuleProviders();
    const matches = providers.filter(
      (provider) => provider === DeliveryThankYouInngestRegistrar,
    );
    expect(matches).toHaveLength(1);
  });
});
