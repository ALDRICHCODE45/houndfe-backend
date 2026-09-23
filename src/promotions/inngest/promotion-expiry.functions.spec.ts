/**
 * pca-3c4b — promotion-expiring Inngest email tests (RED → GREEN).
 *
 * `buildPromotionExpiryFunctions({ inngestClient, ... })` records the
 * configuration handed to `inngest.createFunction` so this spec can invoke the
 * handler directly with a fake `step` + fake `events[]` (the same seam as
 * `promotion-near-capacity.functions.spec.ts` and `low-stock.functions.spec.ts`).
 * The builder stays framework-free: only the fake client is injected here.
 *
 * Contract under test (pca-3c4b):
 *   - `batchEvents: { maxSize: 5, timeout: '30s', key: 'event.data.tenantId' }`,
 *     `idempotency: 'event.id'`, `retries: 3`, `concurrency: { limit: 5 }`.
 *     The producer's event id is the ledger identity
 *     `${tenantId}:${promotionId}:${endDateFingerprint}` (`pca-3c3a`), so a
 *     fingerprint replay dedupes while a genuinely new end date still alerts.
 *   - Master toggle + `PROMOTION_EXPIRING` action + shared recipients are
 *     re-checked at send time.
 *   - Every tenant-scoped read runs INSIDE its `step.run` callback (CLS must be
 *     alive on the same tick as the query).
 *   - Freshness is evaluated PER EVENT with the committed
 *     `findFreshExpiryTitle`, BEFORE collapsing same-promotion duplicates, so an
 *     obsolete later event can never suppress a currently valid earlier
 *     fingerprint in the same batch.
 *   - Deleted/ended/edited/not-started/already-expired promotions are skipped;
 *     an all-stale batch sends nothing and a partial batch sends the fresh ones.
 *   - Nearby expirations for the SAME tenant coalesce into ONE email.
 *   - Mailer failures propagate (Inngest retries), never swallowed.
 *   - No promotion identifier or PII in the rendered body; the end date renders
 *     explicitly in UTC with the fixed `es-AR` locale.
 */
import type { Inngest } from 'inngest';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import {
  PromotionExpiringEmail,
  formatPromotionEndDateUtc,
  promotionExpiringSubject,
  type PromotionExpiringEmailItem,
} from '../../notifications/email/templates/promotion-expiring.email';
import type { PromotionExpiryOutboxPayload } from '../outbox/promotion-expiry-outbox.types';
import { buildPromotionExpiryFunctions } from './promotion-expiry.functions';

const ACTION: NotificationConfigView['enabledActions'][number] =
  'PROMOTION_EXPIRING';

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
 * Inngest v4 takes `(options, handler)`; the fake records both so the spec can
 * assert the frozen options and call the handler directly.
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

/**
 * `step.run` executes the body synchronously and tracks whether a tenant scope
 * was opened while inside a step callback; `runWithTenant` records that flag so
 * the spec can prove CLS ordering.
 */
function makeFakeStep() {
  const stepCalls: string[] = [];
  let stepDepth = 0;
  const step = {
    run: jest.fn(async (name: string, fn: () => Promise<unknown>) => {
      stepCalls.push(name);
      stepDepth += 1;
      try {
        return await fn();
      } finally {
        stepDepth -= 1;
      }
    }),
    sleep: jest.fn(() => Promise.resolve(undefined)),
    sendEvent: jest.fn(() => Promise.resolve(undefined)),
    waitForEvent: jest.fn(() => Promise.resolve(undefined)),
  };
  return {
    step: step as unknown as Record<string, unknown>,
    stepCalls,
    isInsideStep: () => stepDepth > 0,
  };
}

function basePayload(
  overrides: Partial<PromotionExpiryOutboxPayload> = {},
): PromotionExpiryOutboxPayload {
  return {
    tenantId: 'tenant-1',
    promotionId: 'promotion-1',
    endDate: '2026-07-01T21:00:00.000Z',
    endDateFingerprint: '2026-07-01T21:00:00.000Z',
    occurredAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(data: PromotionExpiryOutboxPayload) {
  return {
    id: `${data.tenantId}:${data.promotionId}:${data.endDateFingerprint}`,
    name: 'promotion/expiring.detected',
    data,
  };
}

/** Raw event builder for malformed-payload cases that bypass the type. */
function makeRawEvent(id: string, data: unknown) {
  return { id, name: 'promotion/expiring.detected', data };
}

function sentMail(send: jest.Mock, index = 0): SentMail {
  const calls = send.mock.calls as unknown[][];
  return calls[index]?.[0] as SentMail;
}

interface HarnessOptions {
  config?: Partial<NotificationConfigView>;
  emails?: string[];
  /**
   * Keyed by `${tenantId}:${promotionId}:${endDateFingerprint}`; a missing key
   * or `null` means the promotion is not fresh (deleted/ended/edited/...).
   */
  freshTitles?: Record<string, string | null>;
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
  const freshTitles = options.freshTitles;
  const findFreshExpiryTitle = jest.fn(
    (input: {
      tenantId: string;
      promotionId: string;
      endDateFingerprint: string;
    }): Promise<string | null> => {
      if (!freshTitles) return Promise.resolve(`Título ${input.promotionId}`);
      return Promise.resolve(
        freshTitles[
          `${input.tenantId}:${input.promotionId}:${input.endDateFingerprint}`
        ] ?? null,
      );
    },
  );
  const send =
    options.send ?? jest.fn((): Promise<void> => Promise.resolve(undefined));

  const tenantCalls: Array<{ tenantId: string; insideStep: boolean }> = [];
  const tenantRunnerHolder = { insideStep: () => false };

  const runWithTenant: TenantRunnerService['runWithTenant'] = <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    tenantCalls.push({
      tenantId,
      insideStep: tenantRunnerHolder.insideStep(),
    });
    return fn();
  };

  buildPromotionExpiryFunctions({
    inngestClient: new fake.FakeInngestClient({
      id: 'test',
    }) as unknown as Inngest,
    tenantRunner: { runWithTenant },
    notificationConfigRepository: { find: findConfig },
    userEmailLookup: { resolveEmailsByUserIds },
    promotionAlertLookup: { findFreshExpiryTitle },
    mailer: { send },
    ...(options.appBaseUrl ? { appBaseUrl: options.appBaseUrl } : {}),
  });

  const captured = fake.captured[0];
  return {
    functionOptions: captured.options,
    handler: captured.handler,
    findConfig,
    resolveEmailsByUserIds,
    findFreshExpiryTitle,
    send,
    tenantCalls,
    step: (isInsideStep: () => boolean) => {
      tenantRunnerHolder.insideStep = isInsideStep;
    },
  };
}

describe('promotion-expiring Inngest function (pca-3c4b)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers one function with the frozen batch/idempotency/retry/concurrency contract', () => {
    const harness = createHarness();

    expect(harness.functionOptions).toMatchObject({
      id: 'promotion-expiring-email',
      retries: 3,
      concurrency: { limit: 5 },
    });
    expect(harness.functionOptions.batchEvents).toEqual({
      maxSize: 5,
      timeout: '30s',
      key: 'event.data.tenantId',
    });
    // Fingerprint-scoped `event.id` (tenantId:promotionId:endDateFingerprint):
    // a replay of the same end date dedupes while A -> B -> A keeps B's own
    // independently deliverable identity.
    expect(harness.functionOptions.idempotency).toBe('event.id');
    expect(harness.functionOptions.triggers).toEqual([
      { event: 'promotion/expiring.detected' },
    ]);
  });

  it('coalesces two distinct promotions into ONE email with both titles in deterministic order', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo de verano',
        'tenant-1:promotion-2:2026-07-02T21:00:00.000Z': 'Promo de invierno',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    // Deliberately out of order: the renderer must sort deterministically
    // (promotion-1 before promotion-2), not follow batch order.
    await harness.handler({
      events: [
        makeEvent(
          basePayload({
            promotionId: 'promotion-2',
            endDate: '2026-07-02T21:00:00.000Z',
            endDateFingerprint: '2026-07-02T21:00:00.000Z',
          }),
        ),
        makeEvent(basePayload()),
      ],
      step: fake.step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.to).toEqual(['ops@example.com']);
    expect(mail.subject).toBe('2 promociones vencen pronto');
    expect(mail.html).toContain('Promo de verano');
    expect(mail.html).toContain('Promo de invierno');
    expect(mail.html.indexOf('Promo de verano')).toBeLessThan(
      mail.html.indexOf('Promo de invierno'),
    );
  });

  it('renders the singular subject and calls the tenant-qualified freshness lookup with the exact fingerprint', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    const mail = sentMail(harness.send);
    expect(mail.subject).toBe('1 promoción vence pronto');
    expect(mail.html).toContain('Promo única');
    expect(harness.findFreshExpiryTitle).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      promotionId: 'promotion-1',
      endDateFingerprint: '2026-07-01T21:00:00.000Z',
    });
  });

  it('renders the end date explicitly in UTC with the fixed es-AR locale', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    const expected = formatPromotionEndDateUtc('2026-07-01T21:00:00.000Z');
    expect(expected).toBe('1 de julio de 2026 a las 21:00 UTC');
    const mail = sentMail(harness.send);
    expect(mail.html).toContain(expected);
    expect(mail.html).toContain('UTC');
  });

  it('never leaks the promotion identifier, fingerprint, or tenant id into the email', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    const mail = sentMail(harness.send);
    expect(mail.html).not.toContain('promotion-1');
    expect(mail.html).not.toContain('2026-07-01T21:00:00.000Z');
    expect(mail.html).not.toContain('tenant-1');
    expect(mail.subject).not.toContain('promotion-1');
  });

  it('short-circuits when the notification master toggle is off', async () => {
    const harness = createHarness({ config: { enabled: false } });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    expect(harness.findConfig).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalled();
  });

  it('short-circuits when PROMOTION_EXPIRING is not an enabled action', async () => {
    const harness = createHarness({
      config: { enabledActions: ['PROMOTION_NEAR_CAPACITY'] },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalled();
  });

  it('short-circuits when the shared recipient list is empty', async () => {
    const harness = createHarness({ config: { recipients: [] } });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    expect(harness.resolveEmailsByUserIds).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('short-circuits when no recipient user resolves to an active email', async () => {
    const harness = createHarness({ emails: [] });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalled();
  });

  it('defense-in-depth: a mixed-tenant batch never enriches nor renders the foreign promotion', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo local',
        'tenant-other:promotion-2:2026-07-01T21:00:00.000Z': 'Promo ajena',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeEvent(
          basePayload({
            tenantId: 'tenant-other',
            promotionId: 'promotion-2',
          }),
        ),
      ],
      step: fake.step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.html).toContain('Promo local');
    expect(mail.html).not.toContain('Promo ajena');
    expect(mail.subject).toBe('1 promoción vence pronto');
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalledWith({
      tenantId: 'tenant-other',
      promotionId: 'promotion-2',
      endDateFingerprint: '2026-07-01T21:00:00.000Z',
    });
  });

  it('sends nothing when every promotion in the batch is stale', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': null,
        'tenant-1:promotion-2:2026-07-02T21:00:00.000Z': null,
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await expect(
      harness.handler({
        events: [
          makeEvent(basePayload()),
          makeEvent(
            basePayload({
              promotionId: 'promotion-2',
              endDate: '2026-07-02T21:00:00.000Z',
              endDateFingerprint: '2026-07-02T21:00:00.000Z',
            }),
          ),
        ],
        step: fake.step,
      }),
    ).resolves.toEqual({ skipped: 'all-stale' });

    expect(harness.findFreshExpiryTitle).toHaveBeenCalledTimes(2);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('skips only the stale promotion and still sends the fresh one', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': null,
        'tenant-1:promotion-2:2026-07-02T21:00:00.000Z': 'Promo vigente',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeEvent(
          basePayload({
            promotionId: 'promotion-2',
            endDate: '2026-07-02T21:00:00.000Z',
            endDateFingerprint: '2026-07-02T21:00:00.000Z',
          }),
        ),
      ],
      step: fake.step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.html).toContain('Promo vigente');
    expect(mail.subject).toBe('1 promoción vence pronto');
  });

  it('A/B stale order: an obsolete later event never suppresses the currently valid earlier fingerprint', async () => {
    // The promotion's live end date is A again (A -> B -> A edit). Fingerprint A
    // is fresh; fingerprint B (alerted later) is stale. A naive
    // collapse-first implementation would keep B (latest occurredAt), find it
    // stale, and wrongly send nothing — dropping the whole batch.
    const freshTitles = {
      'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo vigente',
      'tenant-1:promotion-1:2026-08-01T21:00:00.000Z': null,
    };
    const earlierA = makeEvent(basePayload());
    const laterB = makeEvent(
      basePayload({
        endDate: '2026-08-01T21:00:00.000Z',
        endDateFingerprint: '2026-08-01T21:00:00.000Z',
        occurredAt: '2026-07-01T00:10:00.000Z',
      }),
    );

    const forward = createHarness({ freshTitles });
    const forwardStep = makeFakeStep();
    forward.step(forwardStep.isInsideStep);
    await forward.handler({
      events: [earlierA, laterB],
      step: forwardStep.step,
    });

    const reversed = createHarness({ freshTitles });
    const reversedStep = makeFakeStep();
    reversed.step(reversedStep.isInsideStep);
    await reversed.handler({
      events: [laterB, earlierA],
      step: reversedStep.step,
    });

    for (const harness of [forward, reversed]) {
      expect(harness.send).toHaveBeenCalledTimes(1);
      const mail = sentMail(harness.send);
      expect(mail.subject).toBe('1 promoción vence pronto');
      expect(mail.html).toContain('Promo vigente');
      expect(harness.findFreshExpiryTitle).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        promotionId: 'promotion-1',
        endDateFingerprint: '2026-07-01T21:00:00.000Z',
      });
      expect(harness.findFreshExpiryTitle).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        promotionId: 'promotion-1',
        endDateFingerprint: '2026-08-01T21:00:00.000Z',
      });
    }
    // Both orders render the identical, still-valid alert.
    expect(sentMail(forward.send).html).toBe(sentMail(reversed.send).html);
  });

  it('collapses same-promotion duplicates into ONE item regardless of batch order', async () => {
    const fingerprint = '2026-07-01T21:00:00.000Z';
    const freshTitles = {
      [`tenant-1:promotion-1:${fingerprint}`]: 'Promo única',
    };
    const first = makeEvent(
      basePayload({ occurredAt: '2026-07-01T00:00:00.000Z' }),
    );
    const second = makeEvent(
      basePayload({ occurredAt: '2026-07-01T00:05:00.000Z' }),
    );

    const harness = createHarness({ freshTitles });
    const forwardStep = makeFakeStep();
    harness.step(forwardStep.isInsideStep);
    await harness.handler({ events: [first, second], step: forwardStep.step });
    await harness.handler({ events: [second, first], step: forwardStep.step });

    expect(harness.send).toHaveBeenCalledTimes(2);
    const [firstMail, secondMail] = [
      sentMail(harness.send, 0),
      sentMail(harness.send, 1),
    ];
    expect(firstMail.subject).toBe('1 promoción vence pronto');
    expect(firstMail.html).toBe(secondMail.html);
  });

  it('drops malformed payloads without rendering NaN or a broken date', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo válida',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [
        makeEvent(basePayload()),
        makeRawEvent('bad-1', null),
        makeRawEvent('bad-2', { tenantId: 'tenant-1' }),
        makeRawEvent('bad-3', {
          ...basePayload({ promotionId: '' }),
        }),
        makeRawEvent('bad-4', {
          ...basePayload({ endDateFingerprint: '' }),
        }),
        makeRawEvent('bad-5', {
          ...basePayload({
            promotionId: 'promotion-9',
            endDate: 'not-a-date',
            endDateFingerprint: 'not-a-date',
          }),
        }),
      ],
      step: fake.step,
    });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const mail = sentMail(harness.send);
    expect(mail.subject).toBe('1 promoción vence pronto');
    expect(mail.html).toContain('Promo válida');
    expect(mail.html).not.toContain('NaN');
    expect(mail.html).not.toContain('Invalid');
    // Only the single well-formed, non-empty fingerprint was looked up.
    expect(harness.findFreshExpiryTitle).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the immutable event payload while processing', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);
    const event = makeEvent(basePayload());
    const snapshot = JSON.parse(JSON.stringify(event)) as unknown;

    await harness.handler({ events: [event], step: fake.step });

    expect(event).toEqual(snapshot);
  });

  it('runs every tenant-scoped read inside a step.run callback scoped to the batch tenant', async () => {
    const harness = createHarness({
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await harness.handler({
      events: [makeEvent(basePayload())],
      step: fake.step,
    });

    expect(harness.tenantCalls.length).toBeGreaterThanOrEqual(3);
    expect(
      harness.tenantCalls.every((call) => call.tenantId === 'tenant-1'),
    ).toBe(true);
    expect(harness.tenantCalls.every((call) => call.insideStep)).toBe(true);
    expect(fake.stepCalls).toEqual([
      'load-config',
      'resolve-recipients',
      'verify-freshness',
      'send-email',
    ]);
  });

  it('rethrows mailer failures so Inngest can retry the send', async () => {
    const send = jest.fn(
      (): Promise<void> => Promise.reject(new Error('smtp down')),
    );
    const harness = createHarness({
      send,
      freshTitles: {
        'tenant-1:promotion-1:2026-07-01T21:00:00.000Z': 'Promo única',
      },
    });
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await expect(
      harness.handler({ events: [makeEvent(basePayload())], step: fake.step }),
    ).rejects.toThrow('smtp down');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('short-circuits an empty batch without touching config, lookup, or mailer', async () => {
    const harness = createHarness();
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await expect(
      harness.handler({ events: [], step: fake.step }),
    ).resolves.toEqual({ skipped: 'empty-batch' });

    expect(harness.findConfig).not.toHaveBeenCalled();
    expect(harness.findFreshExpiryTitle).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('short-circuits a batch whose first event has no tenant before any read', async () => {
    const harness = createHarness();
    const fake = makeFakeStep();
    harness.step(fake.isInsideStep);

    await expect(
      harness.handler({
        events: [makeRawEvent('bad', { promotionId: 'promotion-1' })],
        step: fake.step,
      }),
    ).resolves.toEqual({ skipped: 'missing-tenant' });

    expect(harness.findConfig).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('exports the React Email component, subject helper, and UTC formatter for the template seam', () => {
    const items: PromotionExpiringEmailItem[] = [
      { title: 'Promo', endDate: '2026-07-01T21:00:00.000Z' },
    ];

    expect(typeof PromotionExpiringEmail).toBe('function');
    expect(promotionExpiringSubject(items.length)).toBe(
      '1 promoción vence pronto',
    );
    expect(promotionExpiringSubject(3)).toBe('3 promociones vencen pronto');
    expect(formatPromotionEndDateUtc('not-a-date')).toBe('');
  });
});
