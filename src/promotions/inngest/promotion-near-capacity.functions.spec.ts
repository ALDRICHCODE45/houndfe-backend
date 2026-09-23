/**
 * pca-3b4b — near-capacity Inngest function tests (RED → GREEN).
 *
 * `buildPromotionNearCapacityFunctions({ inngestClient, ... })` records
 * the configuration handed to `inngest.createFunction` so this spec can
 * invoke the handler directly with a fake `step` + fake `events[]`
 * (same seam as `low-stock.functions.spec.ts`). The builder stays
 * framework-free: only the fake client is injected here.
 *
 * Contract under test (pca-3b4b):
 *   - `batchEvents: { maxSize: 5, timeout: '30s',
 *     key: 'event.data.tenantId' }`, `idempotency: 'event.id'`,
 *     `retries: 3`, `concurrency: { limit: 5 }` — the ledger-scoped
 *     event id is what lets a later sale re-alert after a cancellation.
 *   - Master toggle + `PROMOTION_NEAR_CAPACITY` action + shared
 *     recipients are re-checked at send time.
 *   - Nearby crossings for the SAME tenant coalesce into ONE email.
 *   - Promotion titles are enriched through the tenant-qualified lookup;
 *     a missing title is skipped and an all-missing batch sends nothing.
 *   - Duplicate promotion events collapse to the LATEST `occurredAt`
 *     snapshot with a stable tie-break, so rendering never depends on
 *     batch order and never assumes consumption rises monotonically.
 *   - Mailer failures propagate (Inngest retries), never swallowed.
 *   - No sale/promotion identifier or PII in the rendered body.
 */
import type { Inngest } from 'inngest';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import {
  PromotionNearCapacityEmail,
  promotionNearCapacitySubject,
  type NearCapacityPromotionEmailItem,
} from '../../notifications/email/templates/promotion-near-capacity.email';
import type { PromotionCapacityOutboxPayload } from '../outbox/promotion-capacity-outbox.types';
import { buildPromotionNearCapacityFunctions } from './promotion-near-capacity.functions';

const ACTION: NotificationConfigView['enabledActions'][number] =
  'PROMOTION_NEAR_CAPACITY';

const DEFAULT_CONFIG: NotificationConfigView = {
  enabled: true,
  recipients: ['user-1'],
  enabledActions: [ACTION],
};

interface SentMail {
  to: string[];
  subject: string;
  html: string;
}

/**
 * Inngest v4 takes `(options, handler)`; the fake records both so the
 * spec can assert the frozen options and call the handler directly.
 */
function makeFakeInngest() {
  type Captured = {
    options: Record<string, unknown>;
    handler: (...args: unknown[]) => unknown;
  };
  const captured: Captured[] = [];

  class FakeInngestClient {
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

  return { FakeInngestClient, captured };
}

/** `step.run` executes the body synchronously; `stepCalls` records order. */
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
    name: 'promotion/near-capacity.detected',
    data,
  };
}

function sentMail(send: jest.Mock, index = 0): SentMail {
  const calls = send.mock.calls as unknown[][];
  return calls[index]?.[0] as SentMail;
}

interface HarnessOptions {
  config?: Partial<NotificationConfigView>;
  emails?: string[];
  /** Keyed by `${tenantId}:${promotionId}`; `null` === promotion missing. */
  titles?: Record<string, string | null>;
  appBaseUrl?: string;
  send?: jest.Mock;
}

function createHarness(options: HarnessOptions = {}) {
  const fake = makeFakeInngest();

  const findConfig = jest.fn(
    (): Promise<NotificationConfigView> =>
      Promise.resolve({ ...DEFAULT_CONFIG, ...options.config }),
  );
  const resolveEmailsByUserIds = jest.fn(
    (): Promise<string[]> =>
      Promise.resolve(options.emails ?? ['ops@example.com']),
  );
  const titles = options.titles;
  const findTitle = jest.fn(
    (input: {
      tenantId: string;
      promotionId: string;
    }): Promise<string | null> => {
      if (!titles) return Promise.resolve(`Título ${input.promotionId}`);
      return Promise.resolve(
        titles[`${input.tenantId}:${input.promotionId}`] ?? null,
      );
    },
  );
  const send =
    options.send ?? jest.fn((): Promise<void> => Promise.resolve(undefined));

  const tenantCalls: string[] = [];
  const runWithTenant: TenantRunnerService['runWithTenant'] = <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    tenantCalls.push(tenantId);
    return fn();
  };

  buildPromotionNearCapacityFunctions({
    inngestClient: new fake.FakeInngestClient({
      id: 'test',
    }) as unknown as Inngest,
    tenantRunner: { runWithTenant },
    notificationConfigRepository: { find: findConfig },
    userEmailLookup: { resolveEmailsByUserIds },
    promotionAlertLookup: { findTitle },
    mailer: { send },
    ...(options.appBaseUrl ? { appBaseUrl: options.appBaseUrl } : {}),
  });

  const captured = fake.captured[0];
  return {
    functionOptions: captured.options,
    handler: captured.handler,
    findConfig,
    resolveEmailsByUserIds,
    findTitle,
    send,
    tenantCalls,
  };
}

describe('promotion near-capacity Inngest function (pca-3b4b)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers one function with the frozen batch/idempotency/retry/concurrency contract', () => {
    const harness = createHarness();

    expect(harness.functionOptions).toMatchObject({
      id: 'promotion-near-capacity-email',
      retries: 3,
      concurrency: { limit: 5 },
    });
    expect(harness.functionOptions.batchEvents).toEqual({
      maxSize: 5,
      timeout: '30s',
      key: 'event.data.tenantId',
    });
    // Ledger-scoped `event.id` (tenantId:promotionId:saleId) — a same-sale
    // replay dedupes while a later sale after restoration re-alerts.
    expect(harness.functionOptions.idempotency).toBe('event.id');
    expect(harness.functionOptions.triggers).toEqual([
      { event: 'promotion/near-capacity.detected' },
    ]);
  });

  it('coalesces two distinct promotions into ONE email with both titles in deterministic order', async () => {
    const harness = createHarness({
      titles: {
        'tenant-1:promotion-1': 'Promo de verano',
        'tenant-1:promotion-2': 'Promo de invierno',
      },
    });
    const { step } = makeFakeStep();

    // Deliberately out of order: the renderer must sort deterministically
    // (promotion-1 before promotion-2), not follow batch order.
    await harness.handler({
      events: [
        makeEvent(
          basePayload({ promotionId: 'promotion-2', saleId: 'sale-2' }),
        ),
        makeEvent(
          basePayload({ promotionId: 'promotion-1', saleId: 'sale-1' }),
        ),
      ],
      step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.to).toEqual(['ops@example.com']);
    expect(mail.subject).toBe('2 promociones cerca de su capacidad');
    expect(mail.html).toContain('Promo de verano');
    expect(mail.html).toContain('Promo de invierno');
    expect(mail.html.indexOf('Promo de verano')).toBeLessThan(
      mail.html.indexOf('Promo de invierno'),
    );
  });

  it('renders the singular subject and enriches the title with the tenant-qualified lookup', async () => {
    const harness = createHarness({
      titles: { 'tenant-1:promotion-1': 'Promo única' },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    const mail = sentMail(harness.send);
    expect(mail.subject).toBe('1 promoción cerca de su capacidad');
    expect(mail.html).toContain('Promo única');
    expect(harness.findTitle).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      promotionId: 'promotion-1',
    });
  });

  it('never leaks the sale or promotion identifier into the email body', async () => {
    const harness = createHarness({
      titles: { 'tenant-1:promotion-1': 'Promo única' },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    const mail = sentMail(harness.send);
    expect(mail.html).not.toContain('sale-1');
    expect(mail.html).not.toContain('promotion-1');
  });

  it('short-circuits when the notification master toggle is off', async () => {
    const harness = createHarness({ config: { enabled: false } });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    expect(harness.findConfig).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.findTitle).not.toHaveBeenCalled();
  });

  it('short-circuits when PROMOTION_NEAR_CAPACITY is not an enabled action', async () => {
    const harness = createHarness({
      config: { enabledActions: ['LOW_STOCK'] },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.findTitle).not.toHaveBeenCalled();
  });

  it('short-circuits when the shared recipient list is empty', async () => {
    const harness = createHarness({ config: { recipients: [] } });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    expect(harness.resolveEmailsByUserIds).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('short-circuits when no recipient user resolves to an active email', async () => {
    const harness = createHarness({ emails: [] });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step,
    });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('defense-in-depth: a mixed-tenant batch never enriches nor renders the foreign promotion', async () => {
    const harness = createHarness({
      titles: {
        'tenant-1:promotion-1': 'Promo local',
        'tenant-other:promotion-2': 'Promo ajena',
      },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeEvent(
          basePayload({
            tenantId: 'tenant-other',
            promotionId: 'promotion-2',
            saleId: 'sale-2',
          }),
        ),
      ],
      step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.html).toContain('Promo local');
    expect(mail.html).not.toContain('Promo ajena');
    expect(mail.subject).toBe('1 promoción cerca de su capacidad');
    expect(harness.findTitle).not.toHaveBeenCalledWith({
      tenantId: 'tenant-other',
      promotionId: 'promotion-2',
    });
  });

  it('sends nothing when every promotion title is missing or blank', async () => {
    const harness = createHarness({
      titles: {
        'tenant-1:promotion-1': null,
        'tenant-1:promotion-2': '   ',
      },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeEvent(
          basePayload({ promotionId: 'promotion-2', saleId: 'sale-2' }),
        ),
      ],
      step,
    });

    expect(harness.findTitle).toHaveBeenCalledTimes(2);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('skips only the missing promotion and still sends the resolvable one', async () => {
    const harness = createHarness({
      titles: {
        'tenant-1:promotion-1': null,
        'tenant-1:promotion-2': 'Promo vigente',
      },
    });
    const { step } = makeFakeStep();

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeEvent(
          basePayload({ promotionId: 'promotion-2', saleId: 'sale-2' }),
        ),
      ],
      step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.html).toContain('Promo vigente');
    expect(mail.subject).toBe('1 promoción cerca de su capacidad');
  });

  it('collapses duplicate promotions to the latest occurredAt snapshot, independent of batch order', async () => {
    // A cancellation can drop consumption below the earlier snapshot, so
    // the renderer must take the LATEST snapshot — never the max, never a
    // monotonic assumption.
    const stale = basePayload({
      saleId: 'sale-1',
      previousConsumedProductUnits: 80,
      consumedProductUnits: 91,
      occurredAt: '2026-07-01T00:00:00.000Z',
    });
    const latest = basePayload({
      saleId: 'sale-2',
      previousConsumedProductUnits: 91,
      consumedProductUnits: 82,
      occurredAt: '2026-07-01T00:05:00.000Z',
    });

    const harness = createHarness({
      titles: { 'tenant-1:promotion-1': 'Promo única' },
    });

    await harness.handler({
      events: [makeEvent(stale), makeEvent(latest)],
      step: makeFakeStep().step,
    });
    await harness.handler({
      events: [makeEvent(latest), makeEvent(stale)],
      step: makeFakeStep().step,
    });

    expect(harness.send).toHaveBeenCalledTimes(2);
    const forward = sentMail(harness.send, 0);
    const reversed = sentMail(harness.send, 1);

    expect(forward.subject).toBe('1 promoción cerca de su capacidad');
    expect(reversed.subject).toBe('1 promoción cerca de su capacidad');
    expect(forward.html).toBe(reversed.html);
    expect(forward.html).toContain('82');
    expect(forward.html).not.toContain('91');
  });

  it('rethrows mailer failures so Inngest can retry the send', async () => {
    const send = jest.fn(
      (): Promise<void> => Promise.reject(new Error('smtp down')),
    );
    const harness = createHarness({ send });
    const { step } = makeFakeStep();

    await expect(
      harness.handler({ events: [makeEvent(basePayload())], step }),
    ).rejects.toThrow('smtp down');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs every tenant-scoped step inside runWithTenant with the batch tenant', async () => {
    const harness = createHarness();

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: makeFakeStep().step,
    });

    expect(harness.tenantCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      harness.tenantCalls.every((tenantId) => tenantId === 'tenant-1'),
    ).toBe(true);
  });

  it('short-circuits an empty batch without touching config, lookup, or mailer', async () => {
    const harness = createHarness();

    await expect(
      harness.handler({ events: [], step: makeFakeStep().step }),
    ).resolves.toEqual({ skipped: 'empty-batch' });

    expect(harness.findConfig).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('exports the React Email component and its item view-model for the template seam', () => {
    const items: NearCapacityPromotionEmailItem[] = [
      { title: 'Promo', consumedProductUnits: 80, maxProductUnits: 100 },
    ];

    expect(typeof PromotionNearCapacityEmail).toBe('function');
    expect(promotionNearCapacitySubject(items.length)).toBe(
      '1 promoción cerca de su capacidad',
    );
  });
});
