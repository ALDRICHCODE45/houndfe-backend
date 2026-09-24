/**
 * Spec — delivery-thank-you-notify Inngest function / DTE-4d.handler.
 *
 * Pins the thin wire contract only: registration metadata, the malformed
 * and blank-id guard that runs before any step or port, the single
 * `send-thank-you-email` step delegating to the sender with the parsed
 * ids, verbatim result pass-through, thrown-sender propagation and a
 * retry that calls the sender again. Business policy (gate, provenance,
 * summary, recipient, render, provider send) belongs to the application
 * sender spec; this file asserts the wrapper does NOT re-implement it.
 * No database, no mail provider, no live Inngest runtime. The fake client
 * is a cast-free structural implementation of the builder seam, and the
 * fake step executes the callback in-line — so the retry case is a second
 * handler invocation, NOT proof of SDK step memoization/checkpointing.
 */
import type {
  DeliveryThankYouSendInput,
  DeliveryThankYouSendResult,
} from '../application/delivery-thank-you-sender';
import {
  DELIVERY_THANK_YOU_NOTIFY_EVENT,
  type DeliveryThankYouEventPayload,
} from './delivery-thank-you.event';
import {
  DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
  DELIVERY_THANK_YOU_SEND_STEP_ID,
  buildDeliveryThankYouNotifyFunctions,
  type DeliveryThankYouEventContext,
  type DeliveryThankYouFunctionOptions,
  type DeliveryThankYouHandler,
  type DeliveryThankYouInngestClient,
  type DeliveryThankYouSenderPort,
  type DeliveryThankYouStepTools,
} from './delivery-thank-you-notify.functions';

const ID_FIELDS = ['tenantId', 'saleId', 'routeId', 'stopId'] as const;
const MALFORMED = { status: 'skipped', reason: 'malformed-payload' } as const;

function payload(
  overrides: Partial<DeliveryThankYouEventPayload> = {},
): DeliveryThankYouEventPayload {
  return {
    tenantId: 'tenant-1',
    saleId: 'sale-1',
    routeId: 'route-1',
    stopId: 'stop-1',
    ...overrides,
  };
}

/** Executes the callback and records the trace the sender snapshots. */
class RecordingStep implements DeliveryThankYouStepTools {
  readonly names: string[] = [];
  readonly trace: string[] = [];

  run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    this.names.push(name);
    this.trace.push(`step:${name}`);
    return Promise.resolve(fn());
  }
}

class RecordingSender implements DeliveryThankYouSenderPort {
  readonly payloads: DeliveryThankYouSendInput[] = [];
  traceAtSend: string[] = [];
  private result: DeliveryThankYouSendResult = { status: 'sent' };
  private readonly failures: Error[] = [];

  constructor(private readonly step: RecordingStep) {}

  setResult(result: DeliveryThankYouSendResult): void {
    this.result = result;
  }

  failNext(error = new Error('smtp down')): void {
    this.failures.push(error);
  }
  send(input: DeliveryThankYouSendInput): Promise<DeliveryThankYouSendResult> {
    this.payloads.push(input);
    if (this.traceAtSend.length === 0) {
      this.traceAtSend = [...this.step.trace];
    }
    const failure = this.failures.shift();
    if (failure) {
      return Promise.reject(failure);
    }
    return Promise.resolve(this.result);
  }
}

interface CapturedDefinition {
  options: DeliveryThankYouFunctionOptions;
  handler: DeliveryThankYouHandler;
}

function setup() {
  const step = new RecordingStep();
  const sender = new RecordingSender(step);
  const captured: CapturedDefinition[] = [];
  const inngestClient: DeliveryThankYouInngestClient = {
    createFunction(options, handler) {
      captured.push({ options, handler });
      return { id: (prefix?: string) => prefix ?? options.id };
    },
  };

  const functions = buildDeliveryThankYouNotifyFunctions({
    inngestClient,
    sender,
  });
  const definition = captured[0];
  if (!definition) {
    throw new Error('builder created no function definition');
  }
  return { functions, definition, step, sender };
}

function invoke(
  definition: CapturedDefinition,
  data: unknown,
  step: DeliveryThankYouStepTools,
): Promise<DeliveryThankYouSendResult | typeof MALFORMED> {
  const ctx: DeliveryThankYouEventContext = {
    event: { id: 'evt-1', name: DELIVERY_THANK_YOU_NOTIFY_EVENT, data },
    step,
  };
  return definition.handler(ctx);
}

const MALFORMED_CASES: Array<[string, unknown]> = [
  ['null', null],
  ['scalar', 'not-an-event'],
  ['array', [payload()]],
  ['missing ids', { tenantId: 'tenant-1' }],
  ['mistyped id', { ...payload(), saleId: 7 }],
  ['empty object', {}],
];

const SENDER_RESULTS: DeliveryThankYouSendResult[] = [
  { status: 'sent' },
  { status: 'skipped', reason: 'master-disabled' },
  { status: 'skipped', reason: 'action-disabled' },
  { status: 'skipped', reason: 'provenance-unverified' },
  { status: 'skipped', reason: 'no-summary' },
  { status: 'skipped', reason: 'no-email' },
];

describe('delivery-thank-you-notify Inngest function (DTE-4d.handler)', () => {
  it('registers one function with the contract trigger, event.id dedupe, 3 retries, concurrency 5 and no batching', () => {
    const { functions, definition } = setup();

    expect(functions).toHaveLength(1);
    expect(definition.options).toEqual({
      id: DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
      triggers: [{ event: DELIVERY_THANK_YOU_NOTIFY_EVENT }],
      idempotency: 'event.id',
      retries: 3,
      concurrency: { limit: 5 },
    });
    expect(Object.keys(definition.options)).not.toContain('batchEvents');
  });

  it.each(MALFORMED_CASES)(
    'skips a %s payload before any step or sender call',
    async (_label, data) => {
      const { definition, step, sender } = setup();

      await expect(invoke(definition, data, step)).resolves.toEqual(MALFORMED);

      expect(step.names).toEqual([]);
      expect(sender.payloads).toEqual([]);
    },
  );

  it.each(ID_FIELDS)(
    'skips blank or whitespace-only %s before any step or sender call',
    async (field) => {
      const { definition, step, sender } = setup();

      for (const value of ['   ', '']) {
        await expect(
          invoke(definition, { ...payload(), [field]: value }, step),
        ).resolves.toEqual(MALFORMED);
      }

      expect(step.names).toEqual([]);
      expect(sender.payloads).toEqual([]);
    },
  );

  it('runs exactly one send step and hands the parsed ids to the sender from inside it', async () => {
    const { definition, step, sender } = setup();

    await expect(invoke(definition, payload(), step)).resolves.toEqual({
      status: 'sent',
    });

    expect(step.names).toEqual([DELIVERY_THANK_YOU_SEND_STEP_ID]);
    expect(sender.payloads).toEqual([payload()]);
    // Snapshot taken while the step callback was executing: the sender
    // call is INSIDE `step.run`, not before or after it.
    expect(sender.traceAtSend).toContain(
      `step:${DELIVERY_THANK_YOU_SEND_STEP_ID}`,
    );
    expect(Object.keys(sender.payloads[0])).toEqual([...ID_FIELDS]);
  });

  it.each(SENDER_RESULTS)(
    'passes the sender result through verbatim: %j',
    async (result) => {
      const { definition, step, sender } = setup();
      sender.setResult(result);

      await expect(invoke(definition, payload(), step)).resolves.toBe(result);
      expect(step.names).toEqual([DELIVERY_THANK_YOU_SEND_STEP_ID]);
    },
  );

  it('propagates a thrown sender rejection so the durable runtime can retry the step', async () => {
    const { definition, step, sender } = setup();
    sender.failNext(new Error('smtp down'));

    await expect(invoke(definition, payload(), step)).rejects.toThrow(
      'smtp down',
    );
    expect(sender.payloads).toEqual([payload()]);
  });

  it('invokes the sender again on retry instead of caching a decision in the wrapper', async () => {
    const { definition, step, sender } = setup();
    sender.failNext();

    await expect(invoke(definition, payload(), step)).rejects.toThrow(
      'smtp down',
    );
    await expect(invoke(definition, payload(), step)).resolves.toEqual({
      status: 'sent',
    });

    expect(sender.payloads).toEqual([payload(), payload()]);
    // Two handler invocations re-entered the same step id. This is NOT
    // proof of live SDK checkpointing/memoization.
    expect(step.names).toEqual([
      DELIVERY_THANK_YOU_SEND_STEP_ID,
      DELIVERY_THANK_YOU_SEND_STEP_ID,
    ]);
  });
});
