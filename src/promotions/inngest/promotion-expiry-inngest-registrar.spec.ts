/**
 * pca-3c4c — promotion expiry Inngest registrar wiring tests (RED → GREEN).
 *
 * `PromotionExpiryInngestRegistrar` owns the boot-time lifecycle step that
 * builds the `promotion-expiring-email` function (`pca-3c4b`) and hands it to
 * `InngestService.registerFunctions(...)`, mirroring
 * `PromotionCapacityInngestRegistrar` / `LowStockInngestRegistrar` /
 * `HrTimeOffInngestRegistrar` / `DeliveryRoutesInngestRegistrar`.
 *
 * Contract under test (pca-3c4c):
 *   - Exactly ONE function is registered, with the frozen id
 *     `promotion-expiring-email` — never a duplicate of an existing
 *     production function id (capacity, low-stock, time-off, delivery).
 *   - The event trigger stays the expiry detected event from `pca-3c1a` and
 *     idempotency stays fingerprint-scoped (`event.id`); this slice changes
 *     no events, schemas, payloads, or digests.
 *   - Every injected port reaches the function: config repository, user-email
 *     lookup, promotion alert lookup, mailer, and the tenant runner (tenant
 *     boundary preserved: all tenant-scoped work runs through
 *     `runWithTenant(tenantId, ...)`).
 *   - `APP_WEB_URL` is threaded into the email CTA only when configured.
 *   - Registration is INDEPENDENT of the existing capacity registrar: both
 *     can register against the same service, their ids differ, and neither
 *     overwrites the other.
 */
import type { ConfigService } from '@nestjs/config';
import type { Inngest } from 'inngest';

import type { InngestService } from '../../inngest/inngest.service';
import type { IMailer } from '../../notifications/email/mailer.port';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { IUserEmailLookup } from '../../stock-alerts/domain/user-email-lookup.repository';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';
import {
  PROMOTION_EXPIRING_INNGEST_EVENT,
  type PromotionExpiryOutboxPayload,
} from '../outbox/promotion-expiry-outbox.types';
import { PromotionCapacityInngestRegistrar } from './promotion-capacity-inngest-registrar';
import {
  PROMOTION_EXPIRY_FUNCTION_ID,
  buildPromotionExpiryFunctions,
} from './promotion-expiry.functions';
import { PromotionExpiryInngestRegistrar } from './promotion-expiry-inngest-registrar';

/**
 * Ids already registered by the sibling Inngest registrars. The new function
 * must never collide with any of them (`InngestService` throws on a duplicate
 * id at boot).
 */
const EXISTING_PRODUCTION_FUNCTION_IDS = [
  'low-stock-email',
  'time-off-request-email',
  'delivery-next-stop-notify',
  'promotion-near-capacity-email',
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

/**
 * Fake `InngestService` that enforces the SAME duplicate-id rejection the real
 * service applies, so the independence test is meaningful: two registrars
 * sharing one service must not collide.
 */
function makeFakeInngestService() {
  const { client, captured } = makeFakeInngestClient();
  const registeredIds = new Set<string>();
  const registerFunctions = jest.fn<void, [unknown[]]>((defs: unknown[]) => {
    for (const def of defs) {
      const id = (def as { id?: string }).id;
      if (typeof id === 'string' && registeredIds.has(id)) {
        throw new Error(
          `InngestService.registerFunctions: duplicate function id "${id}".`,
        );
      }
      if (typeof id === 'string') {
        registeredIds.add(id);
      }
    }
  });
  const getClient = jest.fn(() => client);
  const inngestService = {
    getClient,
    registerFunctions,
  } as unknown as InngestService;
  return { inngestService, captured, registerFunctions, registeredIds };
}

function makeHarness(options: { appBaseUrl?: string } = {}) {
  const { inngestService, captured, registerFunctions } =
    makeFakeInngestService();

  const config: NotificationConfigView = {
    enabled: true,
    recipients: ['user-1'],
    enabledActions: ['PROMOTION_EXPIRING'],
  };
  const find = jest.fn<Promise<NotificationConfigView>, []>(() =>
    Promise.resolve(config),
  );
  const resolveEmailsByUserIds = jest.fn<Promise<string[]>, [string[]]>(() =>
    Promise.resolve(['ops@example.com']),
  );
  const findFreshExpiryTitle = jest.fn<Promise<string | null>, [unknown]>(() =>
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

  const registrar = new PromotionExpiryInngestRegistrar(
    inngestService,
    { find } as unknown as INotificationConfigRepository,
    { resolveEmailsByUserIds } as unknown as IUserEmailLookup,
    { findFreshExpiryTitle } as unknown as IPromotionAlertLookup,
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
    findFreshExpiryTitle,
    send,
    tenantCalls,
    get,
  };
}

function basePayload(
  overrides: Partial<PromotionExpiryOutboxPayload> = {},
): PromotionExpiryOutboxPayload {
  return {
    tenantId: 'tenant-1',
    promotionId: 'promotion-1',
    endDate: '2026-07-01T00:00:00.000Z',
    endDateFingerprint: '2026-07-01T00:00:00.000Z',
    occurredAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(data: PromotionExpiryOutboxPayload) {
  return {
    id: `${data.tenantId}:${data.promotionId}:${data.endDateFingerprint}`,
    name: PROMOTION_EXPIRING_INNGEST_EVENT,
    data,
  };
}

function makeFakeStep() {
  return {
    run: (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

describe('PromotionExpiryInngestRegistrar (pca-3c4c)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers exactly one promotion-expiring-email function with InngestService', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    expect(harness.registerFunctions).toHaveBeenCalledTimes(1);
    const registered = harness.registerFunctions.mock.calls[0][0];
    expect(registered).toHaveLength(1);
    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0].options.id).toBe(PROMOTION_EXPIRY_FUNCTION_ID);
    expect(PROMOTION_EXPIRY_FUNCTION_ID).toBe('promotion-expiring-email');
  });

  it('does not reuse an existing production Inngest function id', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    expect(EXISTING_PRODUCTION_FUNCTION_IDS).not.toContain(
      harness.captured[0].options.id,
    );
  });

  it('keeps the frozen expiry trigger and fingerprint-scoped idempotency', () => {
    const harness = makeHarness();

    harness.registrar.onModuleInit();

    const options = harness.captured[0].options;
    expect(options.triggers).toEqual([
      { event: PROMOTION_EXPIRING_INNGEST_EVENT },
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
    // freshness) must run under the trusted tenant id.
    expect(harness.tenantCalls.length).toBeGreaterThan(0);
    expect(harness.tenantCalls.every((id) => id === 'tenant-1')).toBe(true);
    expect(harness.find).toHaveBeenCalledTimes(1);
    expect(harness.resolveEmailsByUserIds).toHaveBeenCalledWith(['user-1']);
    expect(harness.findFreshExpiryTitle).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      promotionId: 'promotion-1',
      endDateFingerprint: '2026-07-01T00:00:00.000Z',
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
      enabledActions: ['PROMOTION_EXPIRING'],
    });
    harness.registrar.onModuleInit();

    await harness.captured[0].handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep(),
    });

    expect(harness.find).toHaveBeenCalledTimes(1);
    expect(harness.resolveEmailsByUserIds).not.toHaveBeenCalled();
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('registers independently from the capacity registrar without a duplicate id', () => {
    const expiryHarness = makeHarness();
    const { inngestService, registeredIds } = makeFakeInngestService();

    // Re-wire the expiry registrar onto the shared fake service, then register
    // BOTH registrars against it. The shared fake rejects duplicate ids, so a
    // collision would throw here.
    const expiryRegistrar = new PromotionExpiryInngestRegistrar(
      inngestService,
      { find: expiryHarness.find } as unknown as INotificationConfigRepository,
      {
        resolveEmailsByUserIds: expiryHarness.resolveEmailsByUserIds,
      } as unknown as IUserEmailLookup,
      {
        findFreshExpiryTitle: expiryHarness.findFreshExpiryTitle,
      } as unknown as IPromotionAlertLookup,
      { send: expiryHarness.send } as unknown as IMailer,
      {
        runWithTenant: (tenantId: string, fn: () => Promise<unknown>) => {
          expiryHarness.tenantCalls.push(tenantId);
          return fn();
        },
      } as unknown as TenantRunnerService,
      { get: expiryHarness.get } as unknown as ConfigService,
    );

    const capacityRegistrar = new PromotionCapacityInngestRegistrar(
      inngestService,
      { find: expiryHarness.find } as unknown as INotificationConfigRepository,
      {
        resolveEmailsByUserIds: expiryHarness.resolveEmailsByUserIds,
      } as unknown as IUserEmailLookup,
      { findTitle: jest.fn() } as unknown as IPromotionAlertLookup,
      { send: expiryHarness.send } as unknown as IMailer,
      {
        runWithTenant: (tenantId: string, fn: () => Promise<unknown>) => {
          expiryHarness.tenantCalls.push(tenantId);
          return fn();
        },
      } as unknown as TenantRunnerService,
      { get: expiryHarness.get } as unknown as ConfigService,
    );

    expect(() => expiryRegistrar.onModuleInit()).not.toThrow();
    expect(() => capacityRegistrar.onModuleInit()).not.toThrow();
    expect(registeredIds.size).toBe(2);
    expect(registeredIds).toContain(PROMOTION_EXPIRY_FUNCTION_ID);
    expect(registeredIds).toContain('promotion-near-capacity-email');
  });

  it('builds the same function the shared builder exports', () => {
    const { client } = makeFakeInngestClient();
    const built = buildPromotionExpiryFunctions({
      inngestClient: client,
      tenantRunner: {} as never,
      notificationConfigRepository: {} as never,
      userEmailLookup: {} as never,
      promotionAlertLookup: {} as never,
      mailer: {} as never,
    });

    expect(built).toHaveLength(1);
    expect((built[0] as { id?: string }).id).toBe(PROMOTION_EXPIRY_FUNCTION_ID);
  });
});
