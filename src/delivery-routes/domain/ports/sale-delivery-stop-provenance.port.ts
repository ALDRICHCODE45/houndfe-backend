/**
 * PORT: ISaleDeliveryStopProvenance (Driven Port) — delivery-routes /
 * DTE-4a.proof.
 *
 * WHY THIS PORT EXISTS — the dormant eligibility gap.
 *
 * `Sale.deliveryStatus` defaults to `DELIVERED` for POS checkout, so a
 * sale can be `CONFIRMED` + `DELIVERED` WITHOUT any delivery-route stop
 * ever having been completed. The thank-you email is a route-delivery
 * acknowledgment: firing it off the sale's own status would send a false
 * "we delivered your order" message on an ordinary counter sale. Sale
 * status alone is therefore NOT proven route delivery; this port is the
 * provenance proof the handler needs before it may treat a sale as
 * route-delivered.
 *
 * WHAT IT PROVES.
 *
 * Exactly one `deliveryRouteStop` row that is simultaneously:
 *   - the exact `stopId` the event named,
 *   - owned by the caller's `tenantId`,
 *   - attached to the exact `routeId` and linked to the exact `saleId`,
 *   - `status: 'COMPLETED'` — never `PENDING`, `IN_PROGRESS` or `SKIPPED`,
 *   - carrying BOTH `checkedInAt` and `completedAt` (a completed stop
 *     records both; a null timestamp means a torn/incomplete row),
 *   - attached to a route whose OWN `tenantId` matches the caller
 *     (defense in depth on the to-one relation: a foreign route must not
 *     launder an otherwise matching stop).
 *
 * Only that conjunction returns `true`.
 *
 * WHAT IT DELIBERATELY DOES NOT GATE — do not "tighten" these later.
 *
 *   - The owning route's `status` is NOT part of the proof. A route is
 *     routinely `CANCELLED` (or already `COMPLETED`) AFTER one of its
 *     stops was completed: the delivery happened, and the provenance is
 *     the completed stop, not the route's current lifecycle phase.
 *   - `Sale.channel` is NOT provenance. POS / online / bot are order
 *     ORIGINS, not delivery evidence; a POS sale a driver really delivered
 *     on a route still deserves the email, and a non-POS sale with no
 *     completed stop still does not. Channel neither proves nor disproves
 *     a route delivery, so it must never stand in for this proof.
 *
 * FAIL-CLOSED.
 *
 * Any blank `tenantId`, `routeId`, `stopId` or `saleId` — EMPTY or
 * WHITESPACE-ONLY — returns `false` WITHOUT touching the database — a
 * missing (or space-padded) identity field is a malformed event, and a
 * malformed event must never resolve to "proven". A missing row, a
 * cross-tenant row, a mismatched route/sale, a non-`COMPLETED` status and
 * an incomplete timestamp pair all resolve to `false`. A non-blank id is
 * never normalized: it is passed to the store exactly as supplied.
 */
export interface ISaleDeliveryStopProvenance {
  /**
   * `true` only when the exact `(tenantId, routeId, stopId, saleId)` tuple
   * names a genuinely `COMPLETED` route stop with both timestamps set and
   * a tenant-matching route. Every other case — including any empty or
   * whitespace-only input — returns `false`. The caller treats `false` as
   * a soft skip (no send), never as an error.
   */
  hasCompletedRouteStop(input: {
    tenantId: string;
    routeId: string;
    stopId: string;
    saleId: string;
  }): Promise<boolean>;
}

/**
 * NestJS injection token. `Symbol.for(...)` so identical tokens are
 * deduped across module instances (matches the cross-context seam
 * convention used by `SALE_DELIVERY_SUMMARY_READER`).
 */
export const SALE_DELIVERY_STOP_PROVENANCE = Symbol.for(
  'ISaleDeliveryStopProvenance',
);
