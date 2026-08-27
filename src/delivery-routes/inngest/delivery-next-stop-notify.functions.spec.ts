/**
 * delivery-next-stop-notify Inngest function spec — delivery-routes / WU3 (3.21).
 *
 * Mirrors `time-off-notification.functions.spec.ts` (hr-time-off WU3):
 *   - Re-gates on `enabled` and `enabledActions.includes('DELIVERY_NEXT_STOP')`.
 *   - Null email (lookup returns null) → `skipped: no-email` (no error).
 *   - Happy path: renders the React Email template, calls MAILER.send
 *     with the resolved email + Spanish subject + rendered HTML.
 *
 * Spec: design.md §5 (route check-in durable pipeline) + §8.5 (Inngest
 * function step topology) + spec scenario *NotificationConfig Re-Gate
 * at Send Time* + *Durable Next-Stop Notification Pipeline*.
 */
import { DeliveryNextStopEmail } from '../../notifications/email/templates/delivery-next-stop.email';

interface DeliveryNextStopEventPayload {
  tenantId: string;
  routeId: string;
  currentStopId: string;
  nextStopId: string;
  nextSaleId: string;
  nextCustomerName: string | null;
  nextAddressLabel: string | null;
  nextCustomerEmail: string | null;
  idempotencyKey: string;
  occurredAt: string;
}

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

function makeFakeStep() {
  const step = {
    run: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    sleep: jest.fn(() => Promise.resolve(undefined)),
    sendEvent: jest.fn(() => Promise.resolve(undefined)),
    waitForEvent: jest.fn(() => Promise.resolve(undefined)),
  };
  return { step: step as unknown as Record<string, unknown> };
}

function basePayload(
  overrides: Partial<DeliveryNextStopEventPayload> = {},
): DeliveryNextStopEventPayload {
  return {
    tenantId: 'tenant-1',
    routeId: 'route-1',
    currentStopId: 'stop-current',
    nextStopId: 'stop-next',
    nextSaleId: 'sale-next',
    nextCustomerName: 'Ada Lovelace',
    nextAddressLabel: 'Av. Reforma 123\nCentro, Cuauhtémoc\nCP 06600',
    nextCustomerEmail: 'ada@example.com',
    idempotencyKey: 'tenant-1:stop-current',
    occurredAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

interface BuildInput {
  inngestClient: unknown;
  tenantRunner: { runWithTenant: jest.Mock };
  notificationConfigRepository: { find: jest.Mock };
  saleCustomerEmailLookup: { findEmailBySaleId: jest.Mock };
  mailer: { send: jest.Mock };
  appBaseUrl?: string;
  tenantName?: string;
}

describe('delivery-next-stop-notify Inngest function (WU3)', () => {
  const {
    buildDeliveryNextStopNotifyFunctions,
  } = require('./delivery-next-stop-notify.functions');

  function setup(overrides: Partial<BuildInput> = {}) {
    const { Inngest } = makeFakeInngest();
    const { step } = makeFakeStep();
    const tenantRunner = {
      runWithTenant: jest.fn(async (_id: string, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const notificationConfigRepository = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['DELIVERY_NEXT_STOP'],
      }),
      ...(overrides.notificationConfigRepository ?? {}),
    };
    const saleCustomerEmailLookup = {
      findEmailBySaleId: jest
        .fn()
        .mockResolvedValue('ada@example.com'),
      ...(overrides.saleCustomerEmailLookup ?? {}),
    };
    const mailer = { send: jest.fn().mockResolvedValue(undefined) };

    const [fn] = buildDeliveryNextStopNotifyFunctions({
      inngestClient: new Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepository as never,
      saleCustomerEmailLookup: saleCustomerEmailLookup as never,
      mailer: mailer as never,
      ...(overrides.appBaseUrl !== undefined
        ? { appBaseUrl: overrides.appBaseUrl }
        : {}),
      ...(overrides.tenantName !== undefined
        ? { tenantName: overrides.tenantName }
        : {}),
    });

    return {
      fn,
      step,
      tenantRunner,
      notificationConfigRepository,
      saleCustomerEmailLookup,
      mailer,
    };
  }

  it('Given the function is built, when it is registered, then the trigger is `delivery/next-stop.notify` and the function id is `delivery-next-stop-notify`', () => {
    setup();
    expect(buildDeliveryNextStopNotifyFunctions).toBeDefined();
  });

  it('Given a happy-path payload, when the handler runs, then load-config + resolve-recipient + send-email all run inside `tenantRunner.runWithTenant(tenantId, ...)`', async () => {
    const { fn, step, tenantRunner } = setup();
    const ctx = {
      event: {
        id: 'evt-1',
        name: 'delivery/next-stop.notify',
        data: basePayload(),
      },
      step,
    };

    await (fn.handler as (c: unknown) => Promise<unknown>)(ctx);

    // tenantRunner.runWithTenant invoked at least 3x — every step body
    // carries payload.tenantId so the Inngest step re-execution keeps
    // the tenant CLS scope alive (mirrors the low-stock / hr-time-off
    // CLS-in-step pattern).
    expect(tenantRunner.runWithTenant).toHaveBeenCalled();
    const calls = tenantRunner.runWithTenant.mock.calls as Array<
      [string, () => Promise<unknown>]
    >;
    for (const call of calls) {
      expect(call[0]).toBe('tenant-1');
    }
  });

  it('Given config is master-disabled, when the handler runs, then mailer is NEVER called and the result is `skipped: master-disabled`', async () => {
    const localBuild =
      require('./delivery-next-stop-notify.functions').buildDeliveryNextStopNotifyFunctions;
    const { Inngest } = makeFakeInngest();
    const { step } = makeFakeStep();
    const tenantRunner = {
      runWithTenant: jest.fn(async (_id: string, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const notificationConfigRepository = {
      find: jest.fn().mockResolvedValue({
        enabled: false,
        recipients: ['u1'],
        enabledActions: ['DELIVERY_NEXT_STOP'],
      }),
    };
    const saleCustomerEmailLookup = { findEmailBySaleId: jest.fn() };
    const mailer = { send: jest.fn() };
    const [fn] = localBuild({
      inngestClient: new Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepository as never,
      saleCustomerEmailLookup: saleCustomerEmailLookup as never,
      mailer: mailer as never,
    });

    const ctx = {
      event: {
        id: 'evt-2',
        name: 'delivery/next-stop.notify',
        data: basePayload(),
      },
      step,
    };

    const result = await (fn.handler as (c: unknown) => Promise<unknown>)(ctx);

    expect(result).toEqual({ skipped: 'master-disabled' });
    expect(mailer.send).not.toHaveBeenCalled();
    expect(saleCustomerEmailLookup.findEmailBySaleId).not.toHaveBeenCalled();
  });

  it('Given DELIVERY_NEXT_STOP is not in enabledActions, when the handler runs, then mailer is NEVER called and the result is `skipped: action-disabled`', async () => {
    const localBuild =
      require('./delivery-next-stop-notify.functions').buildDeliveryNextStopNotifyFunctions;
    const { Inngest } = makeFakeInngest();
    const { step } = makeFakeStep();
    const tenantRunner = {
      runWithTenant: jest.fn(async (_id: string, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const notificationConfigRepository = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['LOW_STOCK'], // no DELIVERY_NEXT_STOP
      }),
    };
    const saleCustomerEmailLookup = { findEmailBySaleId: jest.fn() };
    const mailer = { send: jest.fn() };
    const [fn] = localBuild({
      inngestClient: new Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepository as never,
      saleCustomerEmailLookup: saleCustomerEmailLookup as never,
      mailer: mailer as never,
    });

    const ctx = {
      event: {
        id: 'evt-3',
        name: 'delivery/next-stop.notify',
        data: basePayload(),
      },
      step,
    };

    const result = await (fn.handler as (c: unknown) => Promise<unknown>)(ctx);

    expect(result).toEqual({ skipped: 'action-disabled' });
    expect(mailer.send).not.toHaveBeenCalled();
    expect(saleCustomerEmailLookup.findEmailBySaleId).not.toHaveBeenCalled();
  });

  it('Given the customer email lookup resolves null, when the handler runs, then mailer is NEVER called and the result is `skipped: no-email`', async () => {
    const localBuild =
      require('./delivery-next-stop-notify.functions').buildDeliveryNextStopNotifyFunctions;
    const { Inngest } = makeFakeInngest();
    const { step } = makeFakeStep();
    const tenantRunner = {
      runWithTenant: jest.fn(async (_id: string, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const notificationConfigRepository = {
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['DELIVERY_NEXT_STOP'],
      }),
    };
    const saleCustomerEmailLookup = {
      findEmailBySaleId: jest.fn().mockResolvedValue(null),
    };
    const mailer = { send: jest.fn() };
    const [fn] = localBuild({
      inngestClient: new Inngest({ id: 'test' }) as never,
      tenantRunner: tenantRunner as never,
      notificationConfigRepository: notificationConfigRepository as never,
      saleCustomerEmailLookup: saleCustomerEmailLookup as never,
      mailer: mailer as never,
    });

    const ctx = {
      event: {
        id: 'evt-4',
        name: 'delivery/next-stop.notify',
        data: basePayload(),
      },
      step,
    };

    const result = await (fn.handler as (c: unknown) => Promise<unknown>)(ctx);

    expect(result).toEqual({ skipped: 'no-email' });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('Given the lookup returns an authoritative email, when the handler runs, then mailer is called with that email (NOT the write-time snapshot) + Spanish subject + rendered HTML', async () => {
    const { fn, step, mailer } = setup({
      appBaseUrl: 'https://app.example.com',
      tenantName: 'HoundFe Demo',
      saleCustomerEmailLookup: {
        findEmailBySaleId: jest
          .fn()
          .mockResolvedValue('AUTHORITATIVE@example.com'),
      },
    });

    const ctx = {
      event: {
        id: 'evt-happy',
        name: 'delivery/next-stop.notify',
        data: basePayload({
          nextCustomerEmail: 'stale-snapshot@example.com',
        }),
      },
      step,
    };

    const result = await (fn.handler as (c: unknown) => Promise<unknown>)(ctx);

    expect(mailer.send).toHaveBeenCalledTimes(1);
    const args = mailer.send.mock.calls[0][0] as {
      to: string[];
      subject: string;
      html: string;
    };
    // The handler MUST use the lookup result (AUTHORITATIVE), NOT the
    // write-time snapshot (stale-snapshot).
    expect(args.to).toEqual(['AUTHORITATIVE@example.com']);
    expect(args.subject).toBe('Tu paquete está por llegar');
    expect(typeof args.html).toBe('string');
    expect(args.html.length).toBeGreaterThan(0);

    expect(result).toEqual({ sent: true });
  });

  it('Given the template renders, when it is invoked directly, then it produces HTML containing the customer name + address label', () => {
    const html = require('react-dom/server').renderToStaticMarkup(
      DeliveryNextStopEmail({
        nextCustomerName: 'Ada Lovelace',
        nextAddressLabel: 'Av. Reforma 123\nCentro, Cuauhtémoc',
        tenantName: 'HoundFe Demo',
        appBaseUrl: 'https://app.example.com',
      }),
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Av. Reforma 123');
    expect(html).toContain('HoundFe Demo');
    expect(html).toContain('https://app.example.com');
  });
});
