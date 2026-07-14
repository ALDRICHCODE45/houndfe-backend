/**
 * Work Unit 6 — Response shape for `GET /sales/drafts/:id/applicable-promotions`.
 *
 * Lists the MANUAL promotions the seller can opt-in to on the current
 * draft. Read-only: the engine evaluates eligibility against the current
 * draft state (items, customer, vetoed ids, already-opted-in ids) and
 * returns the surviving candidates. The seller then chooses to apply
 * one via `POST /sales/drafts/:id/manual-promotions/:promotionId`.
 */
export interface ApplicableManualPromotionDto {
  /** Promotion id (used as the `:promotionId` path param on apply). */
  id: string;
  /** Human-readable title (already rendered in the catalog). */
  title: string;
  /**
   * Engine-supported MANUAL promotion types only.
   *
   * WU6 (buy-x-get-y): `BUY_X_GET_Y` is now part of the wire union —
   * a MANUAL `BUY_X_GET_Y` with at least one matching cart line is
   * surfaced here so the frontend can render the opt-in card.
   */
  type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT' | 'BUY_X_GET_Y';
  /**
   * Promotion method discriminator. Today every candidate in
   * `availableManualPromotions` is MANUAL by construction, but the
   * field is exposed explicitly on the wire so the frontend can
   * distinguish available MANUAL promos from applied ones without
   * inferring from context, and never auto-opt-in to a candidate that
   * doesn't carry `method='MANUAL'`.
   */
  method: 'MANUAL';
  /**
   * Eligibility hint for opt-in UX (WUB). `true` iff applying the promo
   * on this cart shape would actually produce a non-zero saving — i.e.
   * for BXGY, the max matching `line.quantity` is >= `buyQuantity +
   * getQuantity`; for ORDER_DISCOUNT and PRODUCT_DISCOUNT, always true
   * (they give something when surfaced). Frontend uses this to block a
   * no-op apply.
   */
  eligible: boolean;
  /**
   * For BXGY candidates only: the promo's `buyQuantity` — the number
   * of units the customer must add to the cart to start a new reward
   * group. `null` for ORDER_DISCOUNT and PRODUCT_DISCOUNT candidates.
   */
  buyQuantity: number | null;
  /**
   * For BXGY candidates only: the promo's `getQuantity` — the number
   * of units that receive the discount per group. `null` for
   * ORDER_DISCOUNT and PRODUCT_DISCOUNT candidates.
   */
  getQuantity: number | null;
  /**
   * Additional units the customer needs to add to make the BXGY
   * candidate eligible (always 0 when `eligible` is already true).
   * For BXGY: `eligible ? 0 : (buyQuantity + getQuantity - maxMatchQty)`
   * (always >= 1 when `eligible` is false). For ORDER_DISCOUNT and
   * PRODUCT_DISCOUNT: always 0.
   */
  unitsNeeded: number;
}

export interface ListApplicablePromotionsResponseDto {
  saleId: string;
  promotions: ApplicableManualPromotionDto[];
}
