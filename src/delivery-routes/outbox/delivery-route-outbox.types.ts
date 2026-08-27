/**
 * Outbox event types — delivery-routes / WU3 (design §8.4).
 *
 * The `delivery.next_stop.notify` event is emitted inside the check-in
 * transaction by `DeliveryRoutesService.checkInStop` (when a next stop
 * exists). The dedicated `DeliveryRoutesOutboxPoller` claims it, the
 * dedicated `DeliveryRoutesOutboxDispatcher` forwards it to Inngest,
 * and the `delivery-next-stop-notify` Inngest function renders the
 * "Tu paquete está por llegar" email.
 *
 * **Payload discipline.** `nextCustomerEmail` is a write-time snapshot.
 * The Inngest function RE-RESOLVES the authoritative email via
 * `ISaleCustomerEmailLookup.findEmailBySaleId({ tenantId, saleId })` so
 * a tenant editing the customer's email between write-time and
 * send-time still receives the up-to-date address. The snapshot stays
 * in the payload for two reasons:
 *
 *   1. Logging / observability — a Poller/Dispatcher crash dump
 *      already carries the address that was sent.
 *   2. Defense-in-depth — the lookup port's null-guard only short-
 *      circuits; we never trust the snapshot to ship.
 *
 * **Idempotency key.** The dispatcher computes
 * `${tenantId}:${currentStopId}` so a poller replay of the SAME row
 * collapses to ONE Inngest event. A new check-in (different
 * `currentStopId`) produces a new idem seed ⇒ a new Inngest event.
 */
export const DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE = 'delivery.next_stop.notify';

/** `aggregateType` carried on the outbox row for observability. */
export const DELIVERY_ROUTE_OUTBOX_AGGREGATE_TYPE = 'DeliveryRoute';

/**
 * Wire payload of the `delivery.next_stop.notify` outbox event. Stored
 * as `payload` (Prisma JSON) on `outbox_events`. Every field is a
 * pre-stringified primitive — the dispatcher forwards `event.payload`
 * verbatim to Inngest, so no Date objects survive the trip.
 */
export interface DeliveryNextStopNotifyPayload {
  tenantId: string;
  routeId: string;
  currentStopId: string;
  nextStopId: string;
  nextSaleId: string;
  nextCustomerName: string | null;
  nextAddressLabel: string | null;
  /**
   * Write-time email snapshot. NOT trusted by the Inngest function —
   * `ISaleCustomerEmailLookup.findEmailBySaleId` is the source of truth
   * at send time.
   */
  nextCustomerEmail: string | null;
  /** Deterministic idempotency seed for Inngest dedupe. */
  idempotencyKey: string;
  /** ISO-8601 timestamp of the check-in that emitted this row. */
  occurredAt: string;
}

/**
 * Compute the deterministic idempotency seed for a next-stop outbox
 * row: `${tenantId}:${currentStopId}`. Two check-ins on the SAME stop
 * collapse to ONE event; a different stop produces a new idem seed.
 */
export function computeDeliveryNextStopIdempotencyKey(input: {
  tenantId: string;
  currentStopId: string;
}): string {
  return `${input.tenantId}:${input.currentStopId}`;
}
