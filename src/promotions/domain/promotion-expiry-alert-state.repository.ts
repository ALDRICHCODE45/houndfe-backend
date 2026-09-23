/**
 * PORT: IPromotionExpiryAlertStateRepository (Driven Port) — pca-3c1a.
 *
 * Atomic, tenant-qualified claim of one promotion's expiration alert. The
 * upcoming scanner (`pca-3c2`) scans promotions that end within the next
 * seven days and hands each candidate id to this port, but the scanner's row
 * may already be stale by the time the claim runs. The port therefore owns
 * one interactive transaction that:
 *
 *   1. locks and re-reads the current `promotions` row (`SELECT ... FOR
 *      UPDATE`) with the caller's `tenantId` in the predicate;
 *   2. revalidates that the row is still effectively ACTIVE — not manually
 *      ended, already started, and ending inside `(now, now+7d]` — using the
 *      transaction's own read instant;
 *   3. seeds the durable state row for `(tenantId, promotionId,
 *      endDateFingerprint)` and flips `alerted = false → true` exactly once;
 *   4. publishes the immutable `promotion.expiring.detected` outbox event in
 *      the SAME transaction, so the state flip and the event commit or roll
 *      back together.
 *
 * Identity is the effective end date itself: `endDateFingerprint` is the
 * persisted `endDate.toISOString()`, never a hash. A → B → A therefore reuses
 * the original A row and can never alert twice for the same end date, while a
 * retry or a concurrent claim loses the guarded flip and returns
 * `already_alerted`.
 *
 * The claim result is intentionally Prisma-free: callers get a typed outcome
 * (`claimed` / `already_alerted` / `not_eligible` plus a reason), never a
 * database row, client, or error code. A publish failure propagates so the
 * ambient transaction rolls back; delivery stays asynchronous and is owned by
 * `pca-3c3`.
 *
 * Inert by design (pca-3c1a): nothing in the active delivery path resolves
 * this token until the scanner and its module wiring land in `pca-3c2`.
 */

/**
 * Expiration alert threshold: a promotion is eligible when it ends strictly
 * after the claim's read instant and no later than seven days after it.
 * Exported so the scanner and the claim revalidation share one definition and
 * cannot drift apart.
 */
export const PROMOTION_EXPIRY_ALERT_WINDOW_DAYS = 7;

/** {@link PROMOTION_EXPIRY_ALERT_WINDOW_DAYS} expressed in milliseconds. */
export const PROMOTION_EXPIRY_ALERT_WINDOW_MS =
  PROMOTION_EXPIRY_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Tenant-qualified claim request; the tenant is never inferred. */
export interface PromotionExpiryAlertClaim {
  tenantId: string;
  promotionId: string;
}

/**
 * Why a claim did not alert. `promotion_not_found` also covers a promotion
 * id owned by another tenant, because the locked re-read is tenant-qualified.
 */
export type PromotionExpiryAlertIneligibleReason =
  | 'promotion_not_found'
  | 'manually_ended'
  | 'not_started'
  | 'end_date_missing'
  | 'expired'
  | 'end_date_out_of_window';

/**
 * Typed claim outcome.
 *
 *   - `claimed` — this call owned the flip; the outbox event was published in
 *     the same transaction.
 *   - `already_alerted` — a previous (or concurrent) claim already alerted
 *     this exact effective end date; nothing was written or published.
 *   - `not_eligible` — the freshly re-read row failed revalidation; nothing
 *     was written or published.
 *
 * `endDate` and `endDateFingerprint` are the same ISO string and are present
 * only when the row was eligible at claim time.
 */
export type PromotionExpiryAlertClaimResult =
  | { outcome: 'claimed'; endDate: string; endDateFingerprint: string }
  | { outcome: 'already_alerted'; endDate: string; endDateFingerprint: string }
  | {
      outcome: 'not_eligible';
      reason: PromotionExpiryAlertIneligibleReason;
    };

export interface IPromotionExpiryAlertStateRepository {
  /**
   * Revalidate `claim` inside one tenant-qualified transaction, seed the
   * end-date fingerprint state row, flip `alerted` once, and publish the
   * `promotion.expiring.detected` outbox event atomically. Never throws for a
   * merely stale or ineligible promotion; those resolve to `not_eligible`.
   */
  claimExpiryAlert(
    claim: PromotionExpiryAlertClaim,
  ): Promise<PromotionExpiryAlertClaimResult>;
}

/**
 * NestJS injection token. `Symbol.for(...)` matches the cross-context seam
 * convention used by `PROMOTION_ALERT_LOOKUP`, `MAILER`, and the other alert
 * ports so identical tokens dedupe across module instances.
 */
export const PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY = Symbol.for(
  'PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY',
);
