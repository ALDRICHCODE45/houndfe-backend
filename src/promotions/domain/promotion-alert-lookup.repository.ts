/**
 * PORT: IPromotionAlertLookup (Driven Port) — pca-3b4a.
 *
 * The near-capacity alert email (`pca-3b4b`, registered in `pca-3b4c`)
 * needs exactly one field from the promotion aggregate: its display
 * title. It must not pull the whole promotions context — or hydrate the
 * full promotion aggregate with its target/customer/price-list graph —
 * into the notification function, so this port exposes one narrow,
 * read-only lookup.
 *
 * Tenant scoping — CRITICAL.
 *
 * The caller passes `tenantId` and `promotionId` explicitly and the
 * adapter puts BOTH into the Prisma `where` clause. A promotion id that
 * is unknown, or that belongs to another tenant, resolves to `null`; the
 * notification flow treats `null` as a soft skip, never as an error.
 *
 * Inert by design (pca-3b4a): this slice adds the seam and its module
 * registration only. Nothing in the active delivery path resolves this
 * token until the alert email function is registered.
 */
export interface IPromotionAlertLookup {
  /**
   * Resolve the display title of a promotion scoped to `tenantId`.
   * Returns `null` when the promotion does not exist in that tenant.
   * Ordering, batching, and recipient gating belong to the caller.
   */
  findTitle(input: {
    tenantId: string;
    promotionId: string;
  }): Promise<string | null>;
}

/**
 * NestJS injection token. `Symbol.for(...)` matches the cross-context
 * seam convention used by `MAILER`, `USER_EMAIL_LOOKUP`, and
 * `SALE_CUSTOMER_EMAIL_LOOKUP` so identical tokens dedupe across module
 * instances.
 */
export const PROMOTION_ALERT_LOOKUP = Symbol.for('PROMOTION_ALERT_LOOKUP');
