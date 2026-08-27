/**
 * PORT: ISaleCustomerEmailLookup (Driven Port) — delivery-routes / WU3.
 *
 * The Inngest `delivery-next-stop-notify` function uses this port to
 * resolve the AUTHORITATIVE customer email at send time. The outbox
 * payload carries a write-time email snapshot for observability only;
 * the Inngest handler MUST re-resolve through this port so a tenant
 * editing the customer's email between check-in and send-time gets the
 * up-to-date address.
 *
 * Tenant scoping — CRITICAL.
 *
 * The sale's `customer` relation joins through the same `tenantId`
 * allowlist as the route itself, so the adapter should pass
 * `where: { id: saleId, tenantId }` explicitly (defense in depth on top
 * of the `TenantPrismaService` CLS injection). A cross-tenant sale id
 * resolves to `null` and the Inngest function logs
 * `skipped: no-email` rather than dispatching to a foreign address.
 *
 * Why a separate port (vs. importing `SalesService` directly)?
 * Keeps the Inngest function module free of sales-management
 * dependencies; the adapter is a single-purpose lookup that does
 * exactly what the notification flow needs.
 */
export interface ISaleCustomerEmailLookup {
  /**
   * Resolve the customer email address for a sale within the caller's
   * tenant. Returns `null` when:
   *   - the sale does not exist in the tenant,
   *   - the sale has no `customer`,
   *   - the customer has no `email` on file.
   * The Inngest handler treats `null` as a soft skip (no email → no
   * send), not as an error.
   */
  findEmailBySaleId(input: {
    tenantId: string;
    saleId: string;
  }): Promise<string | null>;
}

/**
 * NestJS injection token. `Symbol.for(...)` so identical tokens are
 * deduped across module instances (matches the cross-context seam
 * convention used by `MAILER`, `NOTIFICATION_CONFIG_REPOSITORY`,
 * `USER_EMAIL_LOOKUP`).
 */
export const SALE_CUSTOMER_EMAIL_LOOKUP = Symbol.for(
  'ISaleCustomerEmailLookup',
);
