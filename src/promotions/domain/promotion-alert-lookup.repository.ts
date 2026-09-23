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
 *
 * pca-3c4a extends the SAME port with one freshness-gated read for the
 * expiration email. Cancellation is not a concern here (both methods are
 * read-only); the reason the two methods share a port is that both answer
 * "what is this promotion called for this tenant?" from the promotions
 * context, and both must stay tenant-qualified.
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

  /**
   * Resolve the display title of a promotion ONLY while the promotion is
   * still the same live alert the claim hashed, scoped to `tenantId`.
   * Returns `null` when the promotion is missing, owned by another tenant,
   * manually ended, not started yet, already expired, has no end date, whose
   * current `endDate.toISOString()` no longer equals `endDateFingerprint`,
   * or whose title is null/blank.
   *
   * `endDateFingerprint` is the identity persisted by the atomic expiry claim
   * (`pca-3c1a`): the effective end date itself as `endDate.toISOString()`,
   * never a hash. Both the title and the freshness evidence are read in the
   * SAME tenant-qualified row read, so a promotion edited after the claim
   * (A -> B) can never render its new title against the old alert, and no
   * boolean-then-title two-query race is possible.
   *
   * The 7-day claim window is deliberately NOT re-applied here: eligibility
   * was decided under the claim's row lock. Send time only re-checks that the
   * alert is still truthful.
   */
  findFreshExpiryTitle(input: {
    tenantId: string;
    promotionId: string;
    endDateFingerprint: string;
  }): Promise<string | null>;
}

/**
 * NestJS injection token. `Symbol.for(...)` matches the cross-context
 * seam convention used by `MAILER`, `USER_EMAIL_LOOKUP`, and
 * `SALE_CUSTOMER_EMAIL_LOOKUP` so identical tokens dedupe across module
 * instances.
 */
export const PROMOTION_ALERT_LOOKUP = Symbol.for('PROMOTION_ALERT_LOOKUP');
