/**
 * Port for the POS promotion engine (Unit 2 — unwired).
 *
 * The engine is consumed by SalesService via this Symbol token only.
 * SalesService stays free of any direct dependency on promotions
 * internals — it depends on the I/O contract declared here.
 *
 * Two id spaces to keep straight:
 *   - `appliedPriceListId`       : a `PriceList.id` (per-product row)
 *   - `appliedGlobalPriceListId` : the resolved `GlobalPriceList.id`
 *                                  — used for promo price-list eligibility
 *                                  (C1 fix). The caller (SalesService)
 *                                  batches the resolution once per
 *                                  recompute via `ProductsService.
 *                                  resolvePriceListGlobalIds`.
 */
export const POS_EVALUATE_PROMOTIONS_USE_CASE = Symbol(
  'POS_EVALUATE_PROMOTIONS_USE_CASE',
);

/**
 * A single line of a draft sale in the engine's input shape.
 * `effectiveUnitPriceCents` is the pre-promo base
 * (`prePriceCentsBeforeDiscount ?? unitPriceCents`, per S3) and is
 * the value the engine discounts AGAINST — recompute never
 * compounds on re-entry.
 */
export interface PosEvalLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Pre-promo per-unit price in cents (post price-list, pre discount). */
  effectiveUnitPriceCents: number;
  /** `PriceList.id` (per-product row) — raw, NOT used for membership. */
  appliedPriceListId: string | null;
  /** `GlobalPriceList.id` (resolved) — used for promo price-list membership (C1). */
  appliedGlobalPriceListId: string | null;
  /** True when the seller applied a free-form manual discount — auto promo skips. */
  hasManualDiscount: boolean;
}

export interface PosEvalInput {
  /** Recompute time — every gate evaluates against this. */
  now: Date;
  customerId: string | null;
  lines: PosEvalLine[];
  /** Per-draft veto set: AUTO promotion ids the seller has dismissed. */
  vetoedPromotionIds: ReadonlyArray<string>;
  /** Per-draft MANUAL opt-in set. */
  optedInManualPromotionIds: ReadonlyArray<string>;
}

export interface PosEvalLineResult {
  itemId: string;
  promotionId: string;
  /** 'amount' for FIXED, 'percentage' for PERCENTAGE (incl. 100% clamped to 99). */
  discountType: 'amount' | 'percentage';
  /** The value SaleItem.applyDiscount will accept (PERCENTAGE clamped 1..99). */
  discountValue: number;
  discountTitle: string;
}

export interface PosEvalOrderResult {
  promotionId: string;
  discountType: 'amount' | 'percentage';
  discountValue: number;
  discountTitle: string;
  /** Computed in cents at evaluation time (post-line-discount subtotal). */
  discountAmountCents: number;
}

export interface PosEvalManualCandidate {
  id: string;
  title: string;
  type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT';
  /**
   * Promotion method discriminator. Today every candidate in
   * `availableManualPromotions` is MANUAL by construction (the engine
   * filter at pos-evaluate-promotions.use-case.ts:147 only emits promos
   * where `promo.method === 'MANUAL'`), but the field is exposed
   * explicitly on the wire so the frontend can distinguish available
   * MANUAL promos from applied ones without inferring from context, and
   * never auto-opt-in to a candidate that doesn't carry `method='MANUAL'`.
   */
  method: 'MANUAL';
}

export interface PosEvalResult {
  /** Best AUTO PRODUCT promo per eligible line; manual lines and order-level promos do NOT appear here. */
  lines: PosEvalLineResult[];
  /** Best AUTO/OPTED-IN ORDER promo at sale level; null when none eligible. */
  order: PosEvalOrderResult | null;
  /** Eligible MANUAL promotions the seller could opt-in to (excludes opted-in + vetoed). */
  availableManualPromotions: PosEvalManualCandidate[];
}

export interface IPosEvaluatePromotionsUseCase {
  evaluate(input: PosEvalInput): Promise<PosEvalResult>;
}
