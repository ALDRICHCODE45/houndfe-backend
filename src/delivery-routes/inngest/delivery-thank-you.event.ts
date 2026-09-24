/**
 * Dormant event contract — delivery-routes / DTE-4b.event.
 *
 * Pure, framework-free seam for the customer thank-you notification. It
 * declares ONLY the wire identity of the event:
 *
 *   - trigger `delivery/thank-you.notify` (Inngest)
 *   - outbox  `delivery.thank_you.notify` (future dedicated outbox type)
 *   - ids-only payload `{ tenantId, saleId, routeId, stopId }`
 *
 * The two strings map 1:1: the future dedicated dispatcher (DTE-5/DTE-6)
 * must emit `DELIVERY_THANK_YOU_OUTBOX_TYPE`, and the future registrar
 * must subscribe to `DELIVERY_THANK_YOU_NOTIFY_EVENT`.
 *
 * Nothing is wired in this slice: no producer, module, handler or
 * dispatcher. The module has zero imports on purpose, so it cannot reach
 * a database, client, mailer or any other runtime dependency.
 *
 * Integration assumption (NOT an exactly-once guarantee): DTE-5/DTE-6
 * derives the stable Inngest `event.id` from tenant+sale+stop and the
 * consumer dedupes on `event.id`. The contract therefore carries no
 * `idempotencyKey`/`occurredAt`; a crash after provider acceptance but
 * before checkpointing may still re-send.
 */

/** Inngest trigger for the thank-you send; 1:1 with the outbox type below. */
export const DELIVERY_THANK_YOU_NOTIFY_EVENT = 'delivery/thank-you.notify';

/** Future dedicated outbox `type`; 1:1 with the trigger above. */
export const DELIVERY_THANK_YOU_OUTBOX_TYPE = 'delivery.thank_you.notify';

/**
 * Parsed wire payload. Ids only — never email, name, amount or address.
 * The recipient is resolved at send time by the consumer from
 * `tenantId` + `saleId`.
 */
export interface DeliveryThankYouEventPayload {
  tenantId: string;
  saleId: string;
  routeId: string;
  stopId: string;
}

/** True only for a non-null, non-array object (a JSON array is not a payload). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True only for a string with non-whitespace content. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Narrow an untrusted value to the ids-only payload, or `null`.
 *
 * Returns `null` for a non-object, or when ANY of the four identities is
 * missing, mistyped, or blank after trim. Accepted strings are returned
 * verbatim: a padded id (`' sale-1 '`) keeps its original bytes so the
 * consumer, not this contract, owns identity normalization. Extra
 * untrusted properties are ignored and never copied onto the result.
 */
export function parseDeliveryThankYouEventPayload(
  value: unknown,
): DeliveryThankYouEventPayload | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { tenantId, saleId, routeId, stopId } = value;
  if (
    !isNonBlankString(tenantId) ||
    !isNonBlankString(saleId) ||
    !isNonBlankString(routeId) ||
    !isNonBlankString(stopId)
  ) {
    return null;
  }
  // Explicit ids-only projection: no spread, so nothing extra leaks in.
  return { tenantId, saleId, routeId, stopId };
}
