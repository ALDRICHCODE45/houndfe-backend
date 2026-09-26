/**
 * Inngest function — delivery-routes / DTE-4d.handler.
 *
 * Thin wire adapter for the `delivery/thank-you.notify` event. It owns
 * ONLY transport concerns: parse the untrusted ids-only payload through
 * the committed contract parser and run exactly ONE `step.run` whose
 * callback delegates to the application `DeliveryThankYouSender`.
 *
 * The application sender (DTE-4c) owns every business decision — master
 * and action gate, completed-stop provenance, confirmed-delivered
 * summary, authoritative recipient lookup, template render and provider
 * send — inside its OWN fresh tenant CLS scope, which it opens INSIDE
 * the step callback. Opening the scope inside the callback is mandatory:
 * Inngest re-executes the handler body per step and AsyncLocalStorage
 * would be lost if the scope wrapped `step.run` instead of the reverse.
 * This adapter never reads contact, money or timestamp fields, never
 * reads a global tenant display name, and never calls a provider,
 * repository or config directly. A malformed or blank-id payload is
 * rejected before any step or port is touched.
 *
 * One event → one send: no `batchEvents`; replays collapse through
 * `idempotency: 'event.id'`. Retries and concurrency are bounded.
 * Registration is NOT wired here (DTE-4e owns the registrar). With the
 * real client the returned array holds the REAL SDK function object for
 * `InngestService.registerFunctions([...])`.
 */
import type { Inngest } from 'inngest';
import type {
  DeliveryThankYouSendResult,
  DeliveryThankYouSender,
} from '../application/delivery-thank-you-sender';
import {
  DELIVERY_THANK_YOU_NOTIFY_EVENT,
  parseDeliveryThankYouEventPayload,
} from './delivery-thank-you.event';

/** The single function id registered for this trigger. */
export const DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID =
  'delivery-thank-you-notify';
/** The single durable step; its callback is the whole send attempt. */
export const DELIVERY_THANK_YOU_SEND_STEP_ID = 'send-thank-you-email';

/** Bounded per-step retry budget (literal keeps it SDK-assignable). */
const DELIVERY_THANK_YOU_RETRIES = 3;
/** Bounded concurrent sends per function. */
const DELIVERY_THANK_YOU_CONCURRENCY_LIMIT = 5;
/** Application seam: the committed sender, narrowed to its entrypoint. */
export type DeliveryThankYouSenderPort = Pick<DeliveryThankYouSender, 'send'>;

/** Wrapper-level skip for a payload the contract parser rejects. */
export interface DeliveryThankYouMalformedSkip {
  status: 'skipped';
  reason: 'malformed-payload';
}

export type DeliveryThankYouNotifyResult =
  | DeliveryThankYouSendResult
  | DeliveryThankYouMalformedSkip;

/** Step tools used here; generic so the callback result flows through. */
export interface DeliveryThankYouStepTools {
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface DeliveryThankYouEventContext {
  event: { id: string; name: string; data: unknown };
  step: DeliveryThankYouStepTools;
}

export type DeliveryThankYouHandler = (
  ctx: DeliveryThankYouEventContext,
) => Promise<DeliveryThankYouNotifyResult>;

export interface DeliveryThankYouFunctionOptions {
  id: typeof DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID;
  triggers: Array<{ event: typeof DELIVERY_THANK_YOU_NOTIFY_EVENT }>;
  idempotency: 'event.id';
  retries: typeof DELIVERY_THANK_YOU_RETRIES;
  concurrency: { limit: typeof DELIVERY_THANK_YOU_CONCURRENCY_LIMIT };
}

/** The function object `createFunction` hands back to the registrar. */
export interface DeliveryThankYouInngestFunction {
  id(prefix?: string): string;
}

/**
 * Structural seam for the Inngest client. Declared narrowly so the spec
 * can pass a cast-free recorder while the REAL client keeps satisfying
 * it (asserted below).
 */
export interface DeliveryThankYouInngestClient {
  createFunction(
    options: DeliveryThankYouFunctionOptions,
    handler: DeliveryThankYouHandler,
  ): DeliveryThankYouInngestFunction;
}

/**
 * Compile-time evidence — enforced by `nest build`, which excludes specs —
 * that the SDK's real client still satisfies the seam above. If the SDK
 * changes `createFunction` incompatibly this becomes a type error instead
 * of a runtime cast.
 */
type RealClientSatisfiesSeam = Inngest extends DeliveryThankYouInngestClient
  ? true
  : false;
const REAL_CLIENT_SATISFIES_SEAM: RealClientSatisfiesSeam = true;
void REAL_CLIENT_SATISFIES_SEAM;

export interface BuildDeliveryThankYouNotifyFunctionsInput {
  inngestClient: DeliveryThankYouInngestClient;
  sender: DeliveryThankYouSenderPort;
}

/**
 * Build the single `delivery-thank-you-notify` function. Returns the
 * `unknown[]` shape `InngestService.registerFunctions` accepts; nothing
 * registers it in this slice.
 */
export function buildDeliveryThankYouNotifyFunctions(
  input: BuildDeliveryThankYouNotifyFunctionsInput,
): unknown[] {
  const handler: DeliveryThankYouHandler = async (ctx) => {
    // Untrusted wire data: reject malformed and blank ids before any
    // step, scope or port is touched. The contract parser owns shape.
    const payload = parseDeliveryThankYouEventPayload(ctx.event.data);
    if (!payload) {
      return { status: 'skipped', reason: 'malformed-payload' };
    }

    // ONE step: a failed send retries this whole callback and the sender
    // re-opens a fresh tenant scope and re-checks its own policy.
    return ctx.step.run(DELIVERY_THANK_YOU_SEND_STEP_ID, () =>
      input.sender.send(payload),
    );
  };

  const fn = input.inngestClient.createFunction(
    {
      id: DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
      triggers: [{ event: DELIVERY_THANK_YOU_NOTIFY_EVENT }],
      idempotency: 'event.id',
      retries: DELIVERY_THANK_YOU_RETRIES,
      concurrency: { limit: DELIVERY_THANK_YOU_CONCURRENCY_LIMIT },
    },
    handler,
  );

  return [fn];
}
