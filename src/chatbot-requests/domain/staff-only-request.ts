/**
 * `context.origin` of a STAFF-ONLY request (restock-backorder T4): a RESTOCK
 * decision the server created itself for the overdue-ETA re-estimate. It has no
 * customer and no conversation and the bot never asked for it, so it never
 * reaches the bot: closing it (from the staff request inbox or the legacy
 * human-decisions route) produces no generic `request.answered`, and the bot
 * recovery read never lists it. The answer reaches each customer as
 * `backorder.eta_updated` / `backorder.eta_unavailable` instead.
 *
 * Lives in the domain so the wrapper (which writes the origin) and the feed
 * writer (which must honour it) share it without importing each other.
 */
export const STAFF_ONLY_REQUEST_ORIGIN = 'BACKORDER_REESTIMATE';

/** True when a request's `context` JSON marks it as staff-only. */
export function isStaffOnlyContext(context: unknown): boolean {
  return (
    typeof context === 'object' &&
    context !== null &&
    !Array.isArray(context) &&
    (context as Record<string, unknown>).origin === STAFF_ONLY_REQUEST_ORIGIN
  );
}
