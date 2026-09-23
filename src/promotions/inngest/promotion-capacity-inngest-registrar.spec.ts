/**
 * pca-3b4c — promotion capacity Inngest registrar wiring tests (RED → GREEN).
 *
 * `PromotionCapacityInngestRegistrar` owns the boot-time lifecycle step
 * that builds the `promotion-near-capacity-email` function (`pca-3b4b`)
 * and hands it to `InngestService.registerFunctions(...)`, mirroring
 * `LowStockInngestRegistrar` / `HrTimeOffInngestRegistrar` /
 * `DeliveryRoutesInngestRegistrar`.
 *
 * Contract under test (pca-3b4c):
 *   - Exactly ONE function is registered, with the frozen id
 *     `promotion-near-capacity-email` — never a duplicate of an existing
 *     production function id.
 *   - The event trigger stays the capacity crossing event from `pca-3b3a`
 *     and idempotency stays ledger-scoped (`event.id`); this slice does
 *     not change events, schemas, or digests.
 *   - Every injected port reaches the function: config repository,
 *     user-email lookup, promotion alert lookup, mailer, and the tenant
 *     runner (tenant boundary preserved: all tenant-scoped work runs
 *     through `runWithTenant(tenantId, ...)`).
 *   - `APP_WEB_URL` is threaded into the email CTA only when configured.
 *   - `AppModule` registers the registrar as a top-level provider exactly
 *     once so the dependency graph resolves at AppModule scope.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { Inngest } from 'inngest';

// AppModule's transitive graph contains one bare-root import
// (`src/products/products.service`) that Jest cannot resolve without a
// `modulePaths`/`baseUrl` mapping. Register a virtual mock so the
// metadata assertion below can load AppModule without resolving (or
// booting) that unrelated module.
jest.mock(
  'src/products/products.service',
  () => ({ ProductsService: class ProductsService {} }),
  { virtual: true },
);

import { AppModule } from '../../app.module';
import type { InngestService } from '../../inngest/inngest.service';
import type { IMailer } from '../../notifications/email/mailer.port';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { IUserEmailLookup } from '../../stock-alerts/domain/user-email-lookup.repository';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';
import {
  PROMOTION_NEAR_CAPACITY_INNGEST_EVENT,
  type PromotionCapacityOutboxPayload,
} from '../outbox/promotion-capacity-outbox.types';
import { PromotionCapacityInngestRegistrar } from './promotion-capacity-inngest-registrar';
import { PROMOTION_NEAR_CAPACITY_FUNCTION_ID } from './promotion-near-capacity.functions';

/**
 * Ids already registered by the sibling Inngest registrars. The new
 * function must never collide with any of them (`InngestService`
 * throws on a duplicate id at boot).
 */
const EXISTING_PRODUCTION_FUNCTION_IDS = [
  'low-stock-email',
  'time-off-request-email',
  'delivery-next-stop-notify',
];

const APP_BASE_URL = 'https://app.example.com';

type CapturedFunction = {
  options: Record<string, unknown>;
  handler: (ctx: unknown) => Promise<unknown>;
};

function makeFakeInngestClient() {
  const captured: CapturedFunction[] = [];
  const client = {
    createFunction: (
      options: Record<string, unknown>,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => {
      captured.push({ options, handler });
      return { id: options.id };
    },
  };
  return { client: client as unknown as Inngest, captured };
}

function makeHarness(options: { appBaseUrl?: string } = {}) {
  const { client, captured } = makeFakeInngestClient();
  const registerFunctions = jest.fn<void, [unknown[]]>();
  const getClient = jest.fn(() => client);
  const inngestService = {
    getClient,
    registerFunctions,
  } as unknown as InngestService;

  const config: NotificationConfigView = {
    enabled: true,
    recipients: ['user-1'],
    enabledActions: ['PROMOTION_NEAR_CAPACITY'],
  };
  const find = jest.fn<Promise<NotificationConfigView>, []>(() =>
    Promise.resolve(config),
  );
  const resolveEmailsByUserIds = jest.fn<Promise<string[]>, [string[]]>(() =>
    Promise.resolve(['ops@example.com']),
  );
  const findTitle = jest.fn<Promise<string | null>, [unknown]>(() =>
    Promise.resolve('Promo title'),
  );
  const send = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());

  const tenantCalls: string[] = [];
  const runWithTenant = <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    tenantCalls.push(tenantId);
    return fn();
  };

  const appBaseUrl = options.appBaseUrl;
  const get = jest.fn((key: string) =>
    key === 'APP_WEB_URL' ? appBaseUrl : undefined,
  );

  const registrar = new PromotionCapacityInngestRegistrar(
    inngestService,
    { find } as unknown as INotificationConfigRepository,
    { resolveEmailsByUserIds } as unknown as IUserEmailLookup,
    { findTitle } as unknown as IPromotionAlertLookup,
    { send } as unknown as IMailer,
    { runWithTenant } as unknown as TenantRunnerService,
    { get } as unknown as ConfigService,
  );

  return {
    registrar,
    captured,
    registerFunctions,
    find,
    resolveEmailsByUserIds,
    findTitle,
    send,
    tenantCalls,
    get,
  };
}

function basePayload(
  overrides: Partial<PromotionCapacityOutboxPayload> = {},
): PromotionCapacityOutboxPayload {
  return {
    tenantId: 'tenant-1',
    promotionId: 'promotion-1',
    saleId: 'sale-1',
    previousConsumedProductUnits: 79,
    consumedProductUnits: 80,
    maxProductUnits: 100,
    occurredAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(data: PromotionCapacityOutboxPayload) {
  return {
    id: `${data.tenantId}:${data.promotionId}:${data.saleId}`,
    name: PROMOTION_NEAR_CAPACITY_INNGEST_EVENT,
    data,
  };
}

function makeFakeStep() {
  return {
    run: (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

describe('PromotionCapacityInngestRegistrar (pca-3b4c)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers exactly one promotion-near-capacity-email function with InngestService', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    expect(harness.registerFunctions).toHaveBeenCalledTimes(1);
    const registered = harness.registerFunctions.mock.calls[0][0];
    expect(registered).toHaveLength(1);
    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0].options.id).toBe(
      PROMOTION_NEAR_CAPACITY_FUNCTION_ID,
    );
    expect(PROMOTION_NEAR_CAPACITY_FUNCTION_ID).toBe(
      'promotion-near-capacity-email',
    );
  });

  it('does not reuse an existing production Inngest function id', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    expect(EXISTING_PRODUCTION_FUNCTION_IDS).not.toContain(
      harness.captured[0].options.id,
    );
  });

  it('keeps the frozen capacity trigger and ledger-scoped idempotency', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    const options = harness.captured[0].options;
    expect(options.triggers).toEqual([
      { event: PROMOTION_NEAR_CAPACITY_INNGEST_EVENT },
    ]);
    expect(options.idempotency).toBe('event.id');
  });

  it('threads the injected ports through the tenant runner when the function runs', async () => {
    const harness = makeHarness();
    harness.registrar.onModuleInit();

    await harness.captured[0].handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep(),
    });

    // Tenant boundary: every tenant-scoped step (config, recipients,
    // enrichment) must run under the trusted tenant id.
    expect(harness.tenantCalls.length).toBeGreaterThan(0);
    expect(harness.tenantCalls.every((id) => id === 'tenant-1')).toBe(true);
    expect(harness.find).toHaveBeenCalledTimes(1);
    expect(harness.resolveEmailsByUserIds).toHaveBeenCalledWith(['user-1']);
    expect(harness.findTitle).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      promotionId: 'promotion-1',
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = harness.send.mock.calls[0][0] as { to: string[] };
    expect(mail.to).toEqual(['ops@example.com']);
  });

  it('threads APP_WEB_URL into the rendered email CTA when configured', async () => {
    const harness = makeHarness({ appBaseUrl: APP_BASE_URL });
    harness.registrar.onModuleInit();

    await harness.captured[0].handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep(),
    });

    expect(harness.get).toHaveBeenCalledWith('APP_WEB_URL');
    const mail = harness.send.mock.calls[0][0] as { html: string };
    expect(mail.html).toContain(APP_BASE_URL);
  });

  it('omits the CTA when APP_WEB_URL is not configured', async () => {
    const harness = makeHarness();
    harness.registrar.onModuleInit();

    await harness.captured[0].handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep(),
    });

    const mail = harness.send.mock.calls[0][0] as { html: string };
    expect(mail.html).not.toContain(APP_BASE_URL);
  });

  it('honors the injected master toggle and sends no email when disabled', async () => {
    const harness = makeHarness();
    harness.find.mockResolvedValueOnce({
      enabled: false,
      recipients: ['user-1'],
      enabledActions: ['PROMOTION_NEAR_CAPACITY'],
    });
    harness.registrar.onModuleInit();

    await harness.captured[0].handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep(),
    });

    expect(harness.find).toHaveBeenCalledTimes(1);
    expect(harness.resolveEmailsByUserIds).not.toHaveBeenCalled();
    expect(harness.findTitle).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('is registered exactly once as a top-level provider in AppModule', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    ) as unknown[];

    const matches = providers.filter(
      (provider) => provider === PromotionCapacityInngestRegistrar,
    );
    expect(matches).toHaveLength(1);
  });
});
