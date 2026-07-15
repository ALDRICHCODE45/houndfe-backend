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
  /**
   * Resolved product.categoryId — populated by
   * `SalesService.buildPosEvalInput` via
   * `ProductsService.resolveProductCategoryBrandIds` (tenant-scoped,
   * batched once per recompute). `null` when the product has no
   * category OR the id wasn't resolved (omitted-from-map). The
   * `matchTargetTier` CATEGORIES branch reads this; the null value
   * is a structural guard, not a runtime bug.
   */
  categoryId: string | null;
  /**
   * Resolved product.brandId — populated by
   * `SalesService.buildPosEvalInput` (same resolver as categoryId).
   * Symmetric semantics: `null` when unset or unresolved;
   * `matchTargetTier` BRANDS branch reads this.
   */
  brandId: string | null;
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

/**
 * Per-line PER-UNIT engine result (existing PRODUCT_DISCOUNT / ORDER_DISCOUNT
 * line path). Carries the per-unit discount shape that
 * `SaleItem.applyDiscount` consumes directly. The `kind` discriminator
 * is OPTIONAL and defaults to `'per-unit'` for backward compatibility with
 * existing tests/literals that haven't been updated to tag the kind.
 *
 * design.md Decision 3 + Result-contract type — discriminated union with
 * optional `kind` (default `'per-unit'` keeps existing literals compiling).
 */
export interface PosEvalPerUnitLineResult {
  kind?: 'per-unit';
  itemId: string;
  promotionId: string;
  /** 'amount' for FIXED, 'percentage' for PERCENTAGE (incl. 100% clamped to 99). */
  discountType: 'amount' | 'percentage';
  /** The value SaleItem.applyDiscount will accept (PERCENTAGE clamped 1..99). */
  discountValue: number;
  discountTitle: string;
}

/**
 * Per-line BUY_X_GET_Y engine result (whole-line cents reward `R`).
 * Carries the line-total reward shape that `SaleItem.applyBuyXGetYReward`
 * consumes directly (design.md Decision 1). The wire BXGY row uses
 * `lineDiscountCents` as `discountAmountCents` and `perUnitRewardCents`
 * as `discountValue` — SaleItem maps them onto existing columns so no
 * migration is needed.
 *
 * Invariant: `lineDiscountCents > 0`, and
 * `lineDiscountCents < line.effectiveUnitPriceCents * line.quantity`
 * (the entity enforces this — `applyBuyXGetYReward` throws otherwise).
 */
export interface PosEvalBuyXGetYLineResult {
  kind: 'buy-x-get-y';
  itemId: string;
  promotionId: string;
  discountTitle: string;
  /** R — whole-line cents reward (the line subtotal drop). */
  lineDiscountCents: number;
  /** Snapshot of the per-unit reward for the receipt wire field. */
  perUnitRewardCents: number;
  /** Snapshot of the discounted-unit count (groups * M) for the receipt. */
  discountedUnitCount: number;
  /**
   * Exact `getDiscountPercent` (0..100; 100=free, 50=half) of the applied
   * BUY_X_GET_Y promotion. Carried end-to-end so the reward line can expose
   * the true percent instead of deriving it from cents (which drifts ±1 on
   * odd sub-$1 prices).
   */
  getDiscountPercent: number;
}

/**
 * Per-line ADVANCED engine result (whole-line cents reward `R`).
 * Carries the line-total reward shape that `SaleItem.applyBuyXGetYReward`
 * consumes directly (design.md Decision 1 + Decision 4). The wire ADVANCED
 * row uses `lineDiscountCents` as `discountAmountCents` and
 * `perUnitRewardCents` as `discountValue` — same column mapping as BXGY,
 * but with a distinct `rewardKind='advanced'` discriminator persisted on
 * `SaleItem` (Slice 2 / WU5) so the wire can tell the two reward shapes
 * apart.
 *
 * Distinct from `PosEvalBuyXGetYLineResult` because:
 *   - cross-line eligibility source (D1 — BUY-side aggregated across
 *     multiple cart lines, not per-line qty ≥ buyQuantity);
 *   - persisted `rewardKind` differs at the wire ('buy_x_get_y' vs
 *     'advanced' — Slice 2 wire).
 *
 * Same invariant as BXGY: `lineDiscountCents > 0`, and
 * `lineDiscountCents < line.effectiveUnitPriceCents * line.quantity`
 * (the entity enforces this — `applyBuyXGetYReward` throws otherwise).
 */
export interface PosEvalAdvancedLineResult {
  kind: 'advanced';
  itemId: string;
  promotionId: string;
  discountTitle: string;
  /** R — whole-line cents reward (the line subtotal drop). */
  lineDiscountCents: number;
  /** Snapshot of the per-unit reward for the receipt wire field. */
  perUnitRewardCents: number;
  /** Snapshot of the discounted-unit count (groups * M) for the receipt. */
  discountedUnitCount: number;
  /**
   * Exact `getDiscountPercent` (0..100; 100=free, 50=half) of the applied
   * ADVANCED promotion. Carried end-to-end so the reward line can expose
   * the true percent instead of deriving it from cents (which drifts ±1 on
   * odd sub-$1 prices).
   */
  getDiscountPercent: number;
}

/**
 * Per-line engine result — discriminated union. The consumer
 * (`SalesService.recomputePromotions`) branches on `kind` to choose
 * between `SaleItem.applyDiscount` (per-unit) and
 * `SaleItem.applyBuyXGetYReward` (whole-line cents). The discriminated
 * shape is also how the engine's `computeAppliedDiscountCents` knows
 * which discount math to use for the ORDER_DISCOUNT post-line subtotal.
 */
export type PosEvalLineResult =
  | PosEvalPerUnitLineResult
  | PosEvalBuyXGetYLineResult
  | PosEvalAdvancedLineResult;

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
  /**
   * Engine-supported MANUAL promotion types only.
   *
   * WU6 (buy-x-get-y — design.md Decision 7): added `BUY_X_GET_Y` so
   * MANUAL BXGY promotions surface on the wire with the correct type.
   * Frontend uses this to render the candidate card variant.
   */
  type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT' | 'BUY_X_GET_Y';
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
  /**
   * Eligibility hint for opt-in UX (WUB — frontend follow-up). `true`
   * iff applying the promo on the current cart shape would produce a
   * non-zero saving. ORDER_DISCOUNT and PRODUCT_DISCOUNT: always true
   * when surfaced (they give something). BUY_X_GET_Y: true iff
   * `maxMatchQty >= buyQuantity + getQuantity`.
   */
  eligible: boolean;
  /**
   * For BXGY candidates only: the promo's `buyQuantity`. `null` for
   * ORDER_DISCOUNT and PRODUCT_DISCOUNT candidates (the buy/get shape
   * doesn't apply to them).
   */
  buyQuantity: number | null;
  /**
   * For BXGY candidates only: the promo's `getQuantity`. `null` for
   * ORDER_DISCOUNT and PRODUCT_DISCOUNT candidates.
   */
  getQuantity: number | null;
  /**
   * Additional units the customer needs to add to make the candidate
   * eligible (always 0 when `eligible` is already true). For BXGY:
   * `eligible ? 0 : (groupSize - maxMatchQty)` (where `groupSize =
   * buyQuantity + getQuantity`). For ORDER_DISCOUNT and PRODUCT_DISCOUNT:
   * always 0.
   */
  unitsNeeded: number;
}

export interface PosEvalResult {
  /** Best AUTO PRODUCT promo per eligible line; manual lines and order-level promos do NOT appear here. */
  lines: PosEvalLineResult[];
  /** Best AUTO/OPTED-IN ORDER promo at sale level; null when none eligible. */
  order: PosEvalOrderResult | null;
  /** Eligible MANUAL promotions the seller could opt-in to (excludes opted-in + vetoed). */
  availableManualPromotions: PosEvalManualCandidate[];
  /**
   * The subset of `optedInManualPromotionIds` that STILL has at least one
   * matching TARGET in the current cart (i.e. is NOT orphaned). Used by
   * `SalesService.recomputePromotions` to prune opted-in MANUAL promos
   * whose target is gone (the resurrection-bug self-healer).
   *
   * Semantics — distinct from `lines[]` and `availableManualPromotions[]`:
   *   - `lines[]` reports per-line WINNERS (best-wins); an opted-in MANUAL
   *     that lost best-wins, or that targets a line currently carrying a
   *     manual free-form discount, does NOT appear here.
   *   - `availableManualPromotions[]` reports promos the seller could opt
   *     in to NOW (eligible + not yet opted-in + not vetoed).
   *   - `targetableManualPromotionIds` reports the opted-in MANUAL promos
   *     that still have a TARGET line in the cart (eligibility vs. the
   *     cart shape, NOT vs. the best-wins ranking or per-line state
   *     like `hasManualDiscount`).
   *
   * Per-promo inclusion rule (computed by the engine):
   *   - ORDER_DISCOUNT MANUAL + opted-in: ALWAYS included (sale-level;
   *     never "orphaned" by removal of a specific line — the sale still
   *     exists, only the cart contents change).
   *   - PRODUCT_DISCOUNT MANUAL + opted-in: included IFF at least one
   *     line in the cart matches `promo.targetItems` (side=DEFAULT,
   *     targetType=PRODUCTS, targetId=line.productId). The per-line
   *     price-list gate, `hasManualDiscount`, and best-wins loss are
   *     ALL "temporarily ineligible" — the target is still in the cart,
   *     so the opt-in is RETAINED.
   *   - Opted-in MANUAL ids whose promotion is INACTIVE / paused /
   *     scheduled / customer-scope-blocked / vetoed are NOT included;
   *     the engine does not look those up here (they're handled by
   *     `passesPromotionWideGates` upstream).
   */
  targetableManualPromotionIds: string[];
}

export interface IPosEvaluatePromotionsUseCase {
  evaluate(input: PosEvalInput): Promise<PosEvalResult>;
}
