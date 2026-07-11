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
  /** Engine-supported MANUAL promotion types only. */
  type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT';
}

export interface ListApplicablePromotionsResponseDto {
  saleId: string;
  promotions: ApplicableManualPromotionDto[];
}
