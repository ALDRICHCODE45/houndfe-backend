/**
 * PosEvaluatePromotionsUseCase — POS promotion engine.
 *
 * Pure application service. Loads candidate promotions through
 * IPromotionRepository (one query, eager include), then performs
 * in-memory:
 *   - effective status / date-window / dayOfWeek / customerScope
 *     eligibility;
 *   - per-line PRODUCT_DISCOUNT best-wins on `effectiveUnitPriceCents`,
 *     using the resolved `appliedGlobalPriceListId` (C1 fix);
 *   - per-sale ORDER_DISCOUNT best-wins on the post-line-discount
 *     subtotal;
 *   - MANUAL opt-in consideration and veto exclusion;
 *   - `availableManualPromotions[]` for the seller's opt-in UI.
 *
 * The engine does NOT call any database beyond the single
 * `findAll` — caller is responsible for batch-resolving distinct
 * `appliedPriceListId` -> `globalPriceListId` and stuffing the
 * result into each `PosEvalLine.appliedGlobalPriceListId` before
 * calling `evaluate`.
 *
 * CATEGORIES/BRANDS spec scenarios are DEFERRED — `PRODUCT_DISCOUNT`
 * is restricted to `appliesTo='PRODUCTS'` in this slice.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PROMOTION_REPOSITORY } from '../domain/promotion.repository';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { Promotion, type DayOfWeek } from '../domain/promotion.entity';
import type {
  IPosEvaluatePromotionsUseCase,
  PosEvalInput,
  PosEvalLine,
  PosEvalLineResult,
  PosEvalOrderResult,
  PosEvalResult,
  PosEvalManualCandidate,
} from './ports/pos-evaluate-promotions.port';

// ============================================================
// Pure helpers — exported only for testing (W3 clamp invariant)
// ============================================================

/**
 * W3: clamp the percent to the [1, 99] range the entity accepts.
 * Used for BOTH the best-wins comparison value AND the emitted
 * `discountValue`, so the value used for ranking is the value that
 * will actually be applied — the invariant the spec demands.
 */
export function clampPercentageToSafeRange(percent: number): number {
  if (!Number.isFinite(percent)) return 1;
  return Math.min(Math.max(Math.trunc(percent), 1), 99);
}

/**
 * WU1 — Pure helper for BUY_X_GET_Y reward computation (design.md Decision 2;
 * spec.md:60-91,102-106). Per-line (Q2): a single line must have
 * `quantity >= buyQuantity` to trigger; the engine gates on that BEFORE
 * calling this helper. Reward groups are repeatable (Q3): `floor(qty / (N+M))`,
 * with the M discounted get-units per group being the cheapest pre-promo
 * effective unit-price units of the line. When the line carries a single
 * `effectiveUnitPriceCents` (the common case), the per-line saving equals
 * `floor(qty / (N+M)) * M * Math.round((unitPrice * getDiscountPercent) / 100)`
 * — Q8 rounding convention. Returns ZERO reward whenever `qty < N+M` (Q9).
 *
 * Co-located in the use-case module so the engine and its unit tests import
 * the same symbol; the helper is pure (no DI, no I/O) and side-effect free.
 *
 * The reward rides the existing `amount` discount path — `R = lineDiscountCents`
 * is stored on the winning line as the whole-line cents reward; see
 * Decision 1 + Decision 6 for how both readers (previewTotals + receipt
 * mapper) render this as NET under a column-derived discriminator.
 */
export function computeBuyXGetYReward(input: {
  quantity: number;
  effectiveUnitPriceCents: number;
  /** N — units the customer must buy to qualify for the get-units. */
  buyQuantity: number;
  /** M — units the customer receives at a discount per reward group. */
  getQuantity: number;
  /** 0..100 — discount applied to the M get-units (per-unit, not line-total). */
  getDiscountPercent: number;
}): {
  rewardGroups: number;
  discountedUnitCount: number;
  perUnitRewardCents: number;
  lineDiscountCents: number;
} {
  const groupSize = input.buyQuantity + input.getQuantity;
  const rewardGroups = Math.floor(input.quantity / groupSize);
  const discountedUnitCount = rewardGroups * input.getQuantity;
  const perUnitRewardCents = Math.round(
    (input.effectiveUnitPriceCents * input.getDiscountPercent) / 100,
  );
  return {
    rewardGroups,
    discountedUnitCount,
    perUnitRewardCents,
    lineDiscountCents: discountedUnitCount * perUnitRewardCents,
  };
}

/**
 * WU2 — Pure helper for ADVANCED reward computation (design.md
 * Decision 2; spec.md:60-91,102-106). Mirrors `computeBuyXGetYReward`
 * but for the ADVANCED shape: the BUY-side match is AGGREGATED across
 * the whole cart (D1 — `totalBuyMatchedQty` is the sum of all matching
 * line quantities), and the reward can be split across MULTIPLE
 * GET-side lines.
 *
 * Reward groups (D2): `floor(totalBuyMatchedQty / buyQuantity)` —
 * each group discounts `getQuantity` GET units at `getDiscountPercent`
 * of the line's own `effectiveUnitPriceCents`.
 *
 * Multi-GET-line allocation: deterministic lowest-`itemId` ascending
 * (spec.md resolution). The helper sorts the candidate lines by
 * `itemId` asc and walks them in that order until the reward pool is
 * drained. A single line never receives more units than its own
 * `quantity` (the unit-pool cap mirrors the receipt mapper invariant).
 *
 * The helper is pure (no DI, no I/O) and side-effect free.
 *
 * Returns:
 *   - `rewardGroupCount` = `floor(totalBuyMatchedQty / buyQuantity)`.
 *     Zero when BUY is unsatisfied → empty `rewards[]`.
 *   - `rewards[]` — one entry per GET line that received at least one
 *     discounted unit. Sorted by `itemId` asc. Each entry:
 *       `{ itemId, discountedUnitCount, perUnitRewardCents,
 *          lineDiscountCents }`.
 *     `perUnitRewardCents` is the per-unit reward on THAT line (uses
 *     the line's own `effectiveUnitPriceCents` so different GET lines
 *     with different effective prices carry their own per-unit reward
 *     cents).
 *   - `lineDiscountCents = discountedUnitCount * perUnitRewardCents`.
 */
export function computeAdvancedReward(input: {
  totalBuyMatchedQty: number;
  buyQuantity: number;
  getQuantity: number;
  /** 0..100 — discount applied to the M get-units per reward group. */
  getDiscountPercent: number;
  /**
   * Candidate GET-side lines (already filtered to lines that match a
   * GET-side target item). Allocation walks them sorted by `itemId`
   * ascending. Each line contributes `quantity` units to the pool.
   */
  getCandidateLines: ReadonlyArray<{
    itemId: string;
    effectiveUnitPriceCents: number;
    quantity: number;
  }>;
}): {
  rewardGroupCount: number;
  rewards: Array<{
    itemId: string;
    discountedUnitCount: number;
    perUnitRewardCents: number;
    lineDiscountCents: number;
  }>;
} {
  const rewardGroupCount = Math.floor(input.totalBuyMatchedQty / input.buyQuantity);
  if (rewardGroupCount === 0) {
    return { rewardGroupCount: 0, rewards: [] };
  }

  const totalDiscountedUnits = rewardGroupCount * input.getQuantity;

  // Deterministic lowest-itemId asc — see design.md "Open Questions
  // resolved" and the spec resolution note.
  const sortedCandidates = [...input.getCandidateLines].sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
  );

  const rewards: Array<{
    itemId: string;
    discountedUnitCount: number;
    perUnitRewardCents: number;
    lineDiscountCents: number;
  }> = [];

  let remaining = totalDiscountedUnits;
  for (const line of sortedCandidates) {
    if (remaining <= 0) break;
    const take = Math.min(line.quantity, remaining);
    if (take <= 0) continue;
    const perUnitRewardCents = Math.round(
      (line.effectiveUnitPriceCents * input.getDiscountPercent) / 100,
    );
    const lineDiscountCents = take * perUnitRewardCents;
    rewards.push({
      itemId: line.itemId,
      discountedUnitCount: take,
      perUnitRewardCents,
      lineDiscountCents,
    });
    remaining -= take;
  }

  return { rewardGroupCount, rewards };
}

/**
 * Tier returned by `matchTargetTier` — encodes BOTH "did the target
 * hit this line?" AND "which specificity won?" in a single value, so
 * the engine never needs a second predicate pass.
 *
 *   - 'VARIANT'  : a VARIANTS-typed target hit the line's variantId.
 *   - 'PRODUCT'  : no VARIANTS hit, but a PRODUCTS-typed target hit
 *                  the line's productId (back-compat: a PRODUCTS
 *                  promo on product P1 still matches EVERY variant
 *                  of P1).
 *   - 'CATEGORY' : no VARIANTS/PRODUCTS hit, but a CATEGORIES-typed
 *                  target hit the line's resolved categoryId. Null
 *                  categoryId is a structural no-match.
 *   - 'BRAND'    : no VARIANTS/PRODUCTS hit, but a BRANDS-typed
 *                  target hit the line's resolved brandId. Null
 *                  brandId is a structural no-match. BRAND and
 *                  CATEGORY are EQUAL-broadness peers (both ordinal
 *                  1 in the pre-pass; best-wins tiebreaks).
 *   - null       : no target hit the line on the requested side.
 */
export type LineMatchTier = 'VARIANT' | 'PRODUCT' | 'CATEGORY' | 'BRAND' | null;

/**
 * Side filter for `matchTargetTier`. Used by the ADVANCED pass to
 * isolate BUY-side vs GET-side target lists on the same promotion.
 * DEFAULT is the legacy single-side matcher that PRODUCT_DISCOUNT
 * and BUY_X_GET_Y rely on — every existing call site defaults to it
 * (no behavior change).
 *
 *   - 'DEFAULT' : match only targets whose `side === 'DEFAULT'`.
 *   - 'BUY'     : match only targets whose `side === 'BUY'`.
 *   - 'GET'     : match only targets whose `side === 'GET'`.
 */
export type TargetSide = 'DEFAULT' | 'BUY' | 'GET';

/**
 * Match predicate — pure, exported for both testability AND future
 * reuse (online/cart engine `evaluate-cart-promotions.use-case.ts`).
 *
 * Specificity rule: VARIANTS > PRODUCTS > {CATEGORY, BRAND}. Branch
 * order encodes fallthrough — VARIANT first, then PRODUCT, then the
 * two peer tiers (CATEGORY before BRAND; the order between them is
 * arbitrary because they're equal-broadness peers — best-wins
 * resolves the peer tie at the per-line precedence pre-pass in
 * `pickBestPerLine`). Null guards mirror `variantId != null` so an
 * unset/unresolved categoryId/brandId never silently matches.
 *
 * WU1 (advanced-promotion-type): the helper now takes a `side`
 * parameter. `side='DEFAULT'` is the unchanged legacy contract; the
 * ADVANCED pass threads `'BUY'` / `'GET'` to isolate the per-side
 * target list of an ADVANCED promotion (the engine sees both BUY and
 * GET items in `promo.targetItems`, separated by `targetItem.side`).
 */
export function matchTargetTier(
  targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
  line: {
    productId: string;
    variantId: string | null;
    categoryId?: string | null;
    brandId?: string | null;
  },
  side: TargetSide = 'DEFAULT',
): LineMatchTier {
  const effectiveSide = side;
  // VARIANTS first — strict === null on variantId so an unset variant
  // never matches (defensive: structural guarantee).
  if (
    line.variantId != null &&
    targetItems.some(
      (ti) =>
        ti.side === effectiveSide &&
        ti.targetType === 'VARIANTS' &&
        ti.targetId === line.variantId,
    )
  ) {
    return 'VARIANT';
  }
  if (
    targetItems.some(
      (ti) =>
        ti.side === effectiveSide &&
        ti.targetType === 'PRODUCTS' &&
        ti.targetId === line.productId,
    )
  ) {
    return 'PRODUCT';
  }
  // CATEGORIES — null guard on line.categoryId so an unset/unresolved
  // category (product with null categoryId OR id omitted from the
  // resolver map) never silently matches. CATEGORIES comes before
  // BRANDS by convention; both are tier-1 peers so the helper's
  // branch order doesn't affect correctness — the engine's ordinal
  // pre-pass resolves the peer tie by best-wins.
  if (
    line.categoryId != null &&
    targetItems.some(
      (ti) =>
        ti.side === effectiveSide &&
        ti.targetType === 'CATEGORIES' &&
        ti.targetId === line.categoryId,
    )
  ) {
    return 'CATEGORY';
  }
  // BRANDS — null guard on line.brandId, symmetric with CATEGORIES.
  if (
    line.brandId != null &&
    targetItems.some(
      (ti) =>
        ti.side === effectiveSide &&
        ti.targetType === 'BRANDS' &&
        ti.targetId === line.brandId,
    )
  ) {
    return 'BRAND';
  }
  return null;
}

const JS_DAY_OF_WEEK: ReadonlyArray<DayOfWeek> = [
  'SUNDAY', // 0
  'MONDAY', // 1
  'TUESDAY', // 2
  'WEDNESDAY', // 3
  'THURSDAY', // 4
  'FRIDAY', // 5
  'SATURDAY', // 6
];

function jsDayToDayOfWeek(jsDay: number): DayOfWeek {
  // getUTCDay returns 0..6 in UTC regardless of the host's local TZ,
  // making weekday resolution deterministic across host environments.
  const mapped = JS_DAY_OF_WEEK[jsDay];
  if (mapped === undefined) {
    return 'SUNDAY';
  }
  return mapped;
}

// ============================================================
// Use case
// ============================================================

interface PerLineCandidate {
  promotion: Promotion;
  /** Customer discount in cents as it would apply to `effectiveUnitPriceCents`. */
  discountCents: number;
  /** Specificity tier reported by `matchTargetTier` — drives precedence pre-pass. */
  tier: 'VARIANT' | 'PRODUCT' | 'CATEGORY' | 'BRAND';
}

@Injectable()
export class PosEvaluatePromotionsUseCase implements IPosEvaluatePromotionsUseCase {
  constructor(
    @Inject(PROMOTION_REPOSITORY)
    private readonly promotionRepository: IPromotionRepository,
  ) {}

  async evaluate(input: PosEvalInput): Promise<PosEvalResult> {
    // 1. Load candidates once. Do NOT filter by method — MANUAL promos
    //    must be available for opt-in and for ranking when opted-in.
    const { data: candidates } = await this.promotionRepository.findAll({
      page: 1,
      limit: 500,
      status: 'ACTIVE',
    });

    // 2. Pre-promo subtotal (pre-ANY-promo: pre-line-discount AND pre-order).
    //    Used by ORDER_DISCOUNT eligibility (minPurchaseAmountCents).
    const prePromoSubtotalCents = input.lines.reduce(
      (sum, line) => sum + line.effectiveUnitPriceCents * line.quantity,
      0,
    );

    // 3. Per-line best-wins on PRODUCT_DISCOUNT.
    const lineResults: PosEvalLineResult[] = [];
    for (const line of input.lines) {
      const winner = this.pickBestPerLine(line, candidates, input);
      if (winner) {
        lineResults.push(this.toLineResult(line.itemId, winner));
      }
    }

    // 3b. WU3 — Per-line BUY_X_GET_Y pass with cross-type TOTAL-saving
    //     best-wins (design.md Decision 3; spec.md:21-37,60-96).
    //
    //     Runs AFTER the per-line PRODUCT_DISCOUNT loop and BEFORE the
    //     order-subtotal machinery below, so the postLineSubtotalCents
    //     fed to `pickBestOrderPromo` already reflects the BXGY saving.
    //
    //     The comparator (Q5 REVISED) compares REAL per-line TOTAL
    //     savings — NOT per-unit:
    //       pdTotalCents   = existingPd.linePerUnit * line.quantity
    //       bxgyTotalCents = bxgyWinner.lineDiscountCents
    //       bxgy wins IFF bxgyTotalCents > pdTotalCents
    //              OR (bxgyTotalCents === pdTotalCents && bxgyWinner.id < existingPd.promotionId)
    //
    //     When BXGY wins, the existing per-unit result is REPLACED by
    //     a discriminated `kind:'buy-x-get-y'` result carrying the
    //     whole-line reward `R = lineDiscountCents`. No stacking: a
    //     line carries at most ONE applied result.
    this.evaluateBuyXGetYPass(input.lines, candidates, input, lineResults);

    // 3c. WU4 — Per-line ADVANCED pass (design.md Decisions 1+4+5;
    //     spec.md:41-47,72-100,137-149,188-214). Cross-line:
    //     aggregated BUY-side counting (D1) across the whole draft,
    //     per-line reward applied to the matching GET-side lines.
    //     Slots AFTER the per-line BXGY pass (so BXGY targets that
    //     might also be ADVANCED BUY-side still resolve consistently)
    //     and BEFORE the ORDER_DISCOUNT pass (so the post-line
    //     subtotal reflects the ADVANCED saving).
    //
    //     The comparator extends the BXGY 2-way cross-type rule to a
    //     3-way max on `lineTotalSavingCents`:
    //       pdTotalCents      = existingPd.per-unit * line.quantity
    //       bxgyTotalCents    = existingBXGY.lineDiscountCents
    //       advancedTotalCents = advancedWinner.lineDiscountCents
    //       Advanced wins IFF advancedTotalCents > max(pd, bxgy)
    //              OR (tie && advancedId < max.id).
    //
    //     When ADVANCED wins, the existing line result (PD or BXGY)
    //     is REPLACED by a discriminated `kind:'advanced'` result
    //     carrying the whole-line reward R. No stacking: one result
    //     per line.
    this.evaluateAdvancedPass(input.lines, candidates, input, lineResults);

    // 4. Sale-level ORDER_DISCOUNT best-wins.
    //    Subtotal after per-line discounts has been applied.
    const lineDiscountByItemId = new Map<string, number>();
    for (const result of lineResults) {
      const line = input.lines.find((l) => l.itemId === result.itemId);
      if (!line) continue;
      lineDiscountByItemId.set(
        result.itemId,
        this.computeAppliedDiscountCents(line, result),
      );
    }
    const postLineSubtotalCents = input.lines.reduce(
      (sum, line) =>
        sum +
        line.effectiveUnitPriceCents * line.quantity -
        (lineDiscountByItemId.get(line.itemId) ?? 0),
      0,
    );

    const orderResult = this.pickBestOrderPromo(
      candidates,
      input,
      prePromoSubtotalCents,
      postLineSubtotalCents,
    );

    // 5. availableManualPromotions — every eligible MANUAL promo the
    //    seller could opt-in to (not opted-in, not vetoed).
    //
    //    WU6 (buy-x-get-y — design.md Decision 7, spec.md:108-130):
    //    the wire type now includes BUY_X_GET_Y. The candidate is
    //    emitted when the BXGY has at least one matching line in the
    //    cart (same `matchTargetTier` predicate the per-line gate uses)
    //    — a MANUAL BXGY with no matching line is degenerate (no line
    //    can carry the reward) and is silently filtered out.
    //
    //    WUB (frontend follow-up): each candidate now also carries
    //    `eligible`, `buyQuantity`, `getQuantity`, `unitsNeeded` —
    //    the frontend uses these to render an honest hint
    //    ("2x1 · requiere 2 unidades") and to block a no-op apply.
    //    For ORDER_DISCOUNT and PRODUCT_DISCOUNT the eligibility bit is
    //    always true (they give something when surfaced) and the buy/get
    //    fields are null. For BXGY the math is:
    //      groupSize   = buyQuantity + getQuantity
    //      maxMatchQty = max(line.quantity) over matching lines
    //      eligible    = maxMatchQty >= groupSize
    //      unitsNeeded = eligible ? 0 : (groupSize - maxMatchQty) // >=1
    const availableManualPromotions: PosEvalManualCandidate[] = [];
    for (const promo of candidates) {
      if (promo.method !== 'MANUAL') continue;
      if (!this.passesPromotionWideGates(promo, input)) continue;
      if (!this.isSupportedEngineType(promo)) continue;
      if (input.vetoedPromotionIds.includes(promo.id)) continue;
      if (input.optedInManualPromotionIds.includes(promo.id)) continue;

      // ORDER_DISCOUNT: sale-level, always surfaced (the sale exists).
      // PRODUCT_DISCOUNT / BUY_X_GET_Y: only surfaced when at least one
      // line matches the target — the same matcher the per-line gate
      // uses, so the candidate never references a target the engine
      // can't apply to. Branded as 'BUY_X_GET_Y' on the wire.
      let wireType: PosEvalManualCandidate['type'];
      if (promo.type === 'ORDER_DISCOUNT') {
        wireType = 'ORDER_DISCOUNT';
      } else if (promo.type === 'BUY_X_GET_Y') {
        wireType = 'BUY_X_GET_Y';
      } else if (promo.type === 'PRODUCT_DISCOUNT') {
        wireType = 'PRODUCT_DISCOUNT';
      } else {
        continue; // unsupported
      }

      // Eligibility payload (WUB). ORDER_DISCOUNT and PRODUCT_DISCOUNT
      // always give something when surfaced → eligible=true,
      // buy/get=null, unitsNeeded=0. For BXGY we still surface the
      // candidate (so the frontend can render an honest hint) and we
      // compute the derived fields below — same `matchTargetTier`
      // predicate the per-line gate uses.
      let eligible: boolean;
      let buyQuantity: number | null;
      let getQuantity: number | null;
      let unitsNeeded: number;
      if (wireType === 'ORDER_DISCOUNT' || wireType === 'PRODUCT_DISCOUNT') {
        eligible = true;
        buyQuantity = null;
        getQuantity = null;
        unitsNeeded = 0;
      } else {
        // BUY_X_GET_Y
        const buyQ = promo.buyQuantity ?? 0;
        const getQ = promo.getQuantity ?? 0;
        const groupSize = buyQ + getQ;
        // Max matching line quantity — 0 if no line matches (degenerate;
        // we still surface with eligible=false).
        let maxMatchQty = 0;
        for (const line of input.lines) {
          if (matchTargetTier(promo.targetItems, line) === null) continue;
          if (line.quantity > maxMatchQty) maxMatchQty = line.quantity;
        }
        eligible = maxMatchQty >= groupSize;
        unitsNeeded = eligible ? 0 : groupSize - maxMatchQty;
        buyQuantity = buyQ;
        getQuantity = getQ;
      }

      if (wireType !== 'ORDER_DISCOUNT') {
        const hasMatchingLine = input.lines.some(
          (line) => matchTargetTier(promo.targetItems, line) !== null,
        );
        if (!hasMatchingLine) continue;
      }

      availableManualPromotions.push({
        id: promo.id,
        title: promo.title,
        type: wireType,
        // The filter above already pinned `promo.method === 'MANUAL'`, so
        // this is a constant — exposed on the wire (b84aab7) so the
        // frontend can confirm the candidate is MANUAL before offering
        // opt-in. The Promotion.method enum also has AUTOMATIC, but that
        // branch never reaches this mapper.
        method: 'MANUAL',
        // WUB — eligibility hint (see block comment above for semantics).
        eligible,
        buyQuantity,
        getQuantity,
        unitsNeeded,
      });
    }

    // 5b. targetableManualPromotionIds — the subset of
    //     `optedInManualPromotionIds` that still has at least one matching
    //     TARGET line in the current cart (i.e. is NOT orphaned). Consumed
    //     by `SalesService.recomputePromotions` to prune opted-in MANUAL
    //     promos whose target was removed (the resurrection-bug
    //     self-healer — Layer B of the Work Unit 7 fix).
    //
    //     Rule per id (matches the engine's other MANUAL-only paths):
    //     - MANUAL only (AUTOMATIC opt-in is not a thing).
    //     - Not in the veto set (veto wins for symmetry with the line +
    //       order best-wins branches; same corrupt-draft self-heal).
    //     - ORDER_DISCOUNT: ALWAYS included (sale-level; the sale
    //       still exists, only the cart contents change). This
    //       intentionally leaves ORDER_DISCOUNT opt-ins "indefinitely
    //       targetable" — even an empty cart retains the opt-in so the
    //       seller can re-add items later and have the order discount
    //       apply without re-opting-in.
    //     - PRODUCT_DISCOUNT (appliesTo ∈ {PRODUCTS, VARIANTS,
    //       CATEGORIES, BRANDS} — same gate as the line-ranker):
    //       included IFF at least one line in the cart matches
    //       `promo.targetItems`. The per-line price-list gate,
    //       `hasManualDiscount`, and best-wins loss are ALL
    //       "temporarily ineligible" — the target is still in the
    //       cart, so the opt-in is RETAINED.
    //     - BUY_X_GET_Y (WU6 — spec.md:108-130, design.md Decision 7):
    //       symmetric to PRODUCT_DISCOUNT — included IFF at least one
    //       line in the cart matches `promo.targetItems` (same
    //       `matchTargetTier` predicate the per-line BXGY gate uses).
    //       qty < buyQuantity, hasManualDiscount, and best-wins loss
    //       are all "temporarily ineligible" — the target is still in
    //       the cart, so the opt-in is RETAINED across recomputes.
    //
    //     Promotion-wide gates (status / daysOfWeek / customerScope /
    //     supported engine type) are intentionally NOT applied here.
    //     Rationale: those gates describe the PROMO's validity, not
    //     the cart's shape. A paused / scheduled / customer-scope-
    //     blocked promo is "not eligible right now" but its opt-in
    //     should still be retained so a future state change re-enables
    //     it without forcing the seller to re-opt-in. The cross-clear
    //     invariant (vetoed ids are dropped by the `vetoedPromotionIds`
    //     branch above) keeps the corrupt-state guard.
    const targetableManualPromotionIds: string[] = [];
    for (const promo of candidates) {
      if (promo.method !== 'MANUAL') continue;
      if (!input.optedInManualPromotionIds.includes(promo.id)) continue;
      if (input.vetoedPromotionIds.includes(promo.id)) continue;
      // Supported engine type: BUY_X_GET_Y / CATEGORIES / BRANDS / etc.
      // are deferred (see `isSupportedEngineType`). The opt-in for an
      // unsupported promo is a degenerate case (the engine will never
      // apply it), but we still retain it — that's the same
      // "temporarily ineligible" semantics as daysOfWeek / customerScope
      // and keeps the surface symmetric.
      if (!this.isSupportedEngineType(promo)) continue;

      if (promo.type === 'ORDER_DISCOUNT') {
        // Sale-level: always targetable as long as the sale exists.
        targetableManualPromotionIds.push(promo.id);
        continue;
      }
      // PRODUCT_DISCOUNT (appliesTo ∈ {PRODUCTS, VARIANTS,
      // CATEGORIES, BRANDS} — gated by `isSupportedEngineType` above)
      // OR BUY_X_GET_Y (WU6 — same matchTargetTier predicate).
      // At least one line in the cart must match the target.
      if (
        (promo.type === 'PRODUCT_DISCOUNT' ||
          promo.type === 'BUY_X_GET_Y') &&
        this.isSupportedEngineType(promo)
      ) {
        // Self-heal semantics: any tier non-null counts as "still has a
        // matching line". Precedence does NOT prune opt-ins — retention
        // is about target presence, not about which promo wins.
        const hasMatchingLine = input.lines.some(
          (line) => matchTargetTier(promo.targetItems, line) !== null,
        );
        if (hasMatchingLine) {
          targetableManualPromotionIds.push(promo.id);
        }
      }
    }

    return {
      lines: lineResults,
      order: orderResult,
      availableManualPromotions,
      targetableManualPromotionIds,
    };
  }

  // ============================================================
  // Eligibility — promotion-wide gates (no line-specific info)
  // ============================================================

  private passesPromotionWideGates(
    promo: Promotion,
    input: PosEvalInput,
  ): boolean {
    if (this.isSupportedEngineType(promo) === false) return false;

    // 1. Effective status — defense-in-depth vs the DB `status:'ACTIVE'` filter.
    if (promo.getEffectiveStatus(input.now) !== 'ACTIVE') return false;

    // 2. daysOfWeek — empty opens the gate.
    if (promo.daysOfWeek.length > 0) {
      const today = jsDayToDayOfWeek(input.now.getUTCDay());
      const allowed = promo.daysOfWeek.some((d) => d.day === today);
      if (!allowed) return false;
    }

    // 3. customerScope
    const customerId = input.customerId;
    if (promo.customerScope === 'REGISTERED_ONLY' && customerId == null) {
      return false; // silent skip — no exception
    }
    if (promo.customerScope === 'SPECIFIC') {
      if (customerId == null) return false; // silent skip
      const allowed = promo.customers.some((c) => c.customerId === customerId);
      if (!allowed) return false;
    }

    return true;
  }

  private isSupportedEngineType(promo: Promotion): boolean {
    // First slice (Unit 2): PRODUCT_DISCOUNT (PRODUCTS only) + ORDER_DISCOUNT.
    //
    // W4: PRODUCT_DISCOUNT with appliesTo='VARIANTS' is now supported too.
    // Both PRODUCTS and VARIANTS ride the same `matchTargetTier` helper,
    // which encodes the VARIANT-wins-over-PRODUCTS precedence.
    //
    // W2: PRODUCT_DISCOUNT with appliesTo ∈ {CATEGORIES, BRANDS} is
    // now supported as well. The matcher (`matchTargetTier`)
    // branches out into CATEGORIES/BRANDS lines that compare the
    // line's resolved categoryId/brandId against the DEFAULT-side
    // targetItems. The per-line precedence pre-pass in
    // `pickBestPerLine` keeps BRAND/CATEGORY candidates only when no
    // VARIANT/PRODUCT candidate hits the same line (ordinal ladder:
    // V=3, P=2, B=1, C=1).
    //
    // WU3 (buy-x-get-y — design.md Decision 4): BUY_X_GET_Y is now
    // admitted for `appliesTo ∈ {PRODUCTS, VARIANTS, CATEGORIES,
    // BRANDS}` — the same four tier types the matcher supports. The
    // Q1 targeting-required contract is enforced upstream by
    // `promotions.service.assertBuyXGetYTargeted` (out of this
    // slice — WU5); the gate here only checks TYPE membership, not
    // presence-of-target. An BXGY that somehow reaches the gate
    // without a target silently fails to match any line and emits
    // no per-line result — degenerate but never crashes.
    //
    // WU4 (advanced-promotion-type — design.md Decisions 1+2+4):
    // ADVANCED is admitted when `buyTargetType` and `getTargetType`
    // each resolve to one of the four supported tier types
    // {PRODUCTS, VARIANTS, CATEGORIES, BRANDS}. null targets or
    // unsupported values silently skip the candidate (spec.md:52-55).
    // The buy/get disjoint check (D7) lives in promotions.service
    // intake (Slice 3 / WU8) — the engine is free of overlap logic
    // by construction.
    if (promo.type === 'ORDER_DISCOUNT') return true;
    if (
      promo.type === 'PRODUCT_DISCOUNT' &&
      (promo.appliesTo === 'PRODUCTS' ||
        promo.appliesTo === 'VARIANTS' ||
        promo.appliesTo === 'CATEGORIES' ||
        promo.appliesTo === 'BRANDS')
    ) {
      return true;
    }
    if (
      promo.type === 'BUY_X_GET_Y' &&
      (promo.appliesTo === 'PRODUCTS' ||
        promo.appliesTo === 'VARIANTS' ||
        promo.appliesTo === 'CATEGORIES' ||
        promo.appliesTo === 'BRANDS')
    ) {
      return true;
    }
    if (
      promo.type === 'ADVANCED' &&
      (promo.buyTargetType === 'PRODUCTS' ||
        promo.buyTargetType === 'VARIANTS' ||
        promo.buyTargetType === 'CATEGORIES' ||
        promo.buyTargetType === 'BRANDS') &&
      (promo.getTargetType === 'PRODUCTS' ||
        promo.getTargetType === 'VARIANTS' ||
        promo.getTargetType === 'CATEGORIES' ||
        promo.getTargetType === 'BRANDS')
    ) {
      return true;
    }
    return false;
  }

  // ============================================================
  // Per-line best-wins
  // ============================================================

  private pickBestPerLine(
    line: PosEvalLine,
    candidates: ReadonlyArray<Promotion>,
    input: PosEvalInput,
  ): PerLineCandidate | null {
    // Manual free-form discount wins — auto promo skips this line.
    if (line.hasManualDiscount) return null;

    const eligible: PerLineCandidate[] = [];

    for (const promo of candidates) {
      // MANUAL only considered when opted-in. ALSO skip MANUAL ids that
      // appear in the veto set — legacy corrupt drafts persisted before
      // the entity cross-clear (sale.entity.ts#addVetoedPromotion /
      // optInManualPromotion) may carry the same id in BOTH sets.
      // The veto wins (safe default): such drafts self-heal on the
      // next recompute instead of re-applying a promo the seller
      // already dismissed.
      if (promo.method === 'MANUAL') {
        if (!input.optedInManualPromotionIds.includes(promo.id)) continue;
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      } else {
        // AUTOMATIC — exclude vetoed ids.
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      }

      if (!this.passesPromotionWideGates(promo, input)) continue;

      // PRODUCT_DISCOUNT with appliesTo ∈ {PRODUCTS, VARIANTS}. The
      // helper returns the specificity tier (or null when no hit).
      if (promo.type !== 'PRODUCT_DISCOUNT') continue;

      const tier = matchTargetTier(promo.targetItems, line);
      if (tier === null) continue;

      // Price-list gate — match against resolved global id (C1).
      if (promo.priceLists.length > 0) {
        const globalId = line.appliedGlobalPriceListId;
        if (globalId == null) continue;
        const allowed = promo.priceLists.some(
          (pl) => pl.globalPriceListId === globalId,
        );
        if (!allowed) continue;
      }

      const baseline = line.effectiveUnitPriceCents;
      const discountCents = this.computeLineDiscountCents(promo, baseline);
      // Ranking value === applicable value. W3 invariant: the value
      // the entity will apply is the value we rank with.
      if (discountCents <= 0) continue;

      eligible.push({ promotion: promo, discountCents, tier });
    }

    if (eligible.length === 0) return null;

    // ── Per-line precedence pre-pass (ordinal specificity ladder) ──
    // Keep only candidates at the MAX ordinal present on this line,
    // then best-wins (max discount, ties→lowest id). Ordinals:
    //
    //   VARIANT  = 3   (most specific)
    //   PRODUCT  = 2
    //   BRAND    = 1   (peer of CATEGORY — EQUAL-broadness)
    //   CATEGORY = 1   (peer of BRAND   — EQUAL-broadness)
    //
    // Zero-regression argument: for VARIANT/PRODUCT-only inputs the
    // max is 3 iff any VARIANT exists (keeps only VARIANT candidates
    // — identical to the old `hasVariantTier` branch), else 2 (keeps
    // all PRODUCT candidates — identical to the old `else` branch).
    // BRAND and CATEGORY share ordinal 1, so when neither VARIANT nor
    // PRODUCT hits the line both survive and compete on best-wins —
    // no BRAND-over-CATEGORY hierarchy.
    const TIER_ORDINAL: Record<
      'VARIANT' | 'PRODUCT' | 'BRAND' | 'CATEGORY',
      number
    > = {
      VARIANT: 3,
      PRODUCT: 2,
      BRAND: 1,
      CATEGORY: 1,
    };
    const maxOrdinal = eligible.reduce(
      (m, c) => Math.max(m, TIER_ORDINAL[c.tier]),
      0,
    );
    const survivors = eligible.filter(
      (c) => TIER_ORDINAL[c.tier] === maxOrdinal,
    );

    return this.pickBestByMaxDiscountThenLowestId(survivors);
  }

  private computeLineDiscountCents(promo: Promotion, baseline: number): number {
    if (promo.discountType == null || promo.discountValue == null) return 0;
    if (baseline <= 0) return 0;

    if (promo.discountType === 'PERCENTAGE') {
      const safePercent = clampPercentageToSafeRange(promo.discountValue);
      return Math.round((baseline * safePercent) / 100);
    }
    // FIXED
    if (!Number.isInteger(promo.discountValue) || promo.discountValue <= 0) {
      return 0;
    }
    return Math.min(promo.discountValue, baseline);
  }

  private pickBestByMaxDiscountThenLowestId(
    candidates: ReadonlyArray<PerLineCandidate>,
  ): PerLineCandidate | null {
    let best: PerLineCandidate | null = null;
    for (const c of candidates) {
      if (
        best === null ||
        c.discountCents > best.discountCents ||
        (c.discountCents === best.discountCents &&
          c.promotion.id < best.promotion.id)
      ) {
        best = c;
      }
    }
    return best;
  }

  private toLineResult(
    itemId: string,
    winner: PerLineCandidate,
  ): PosEvalLineResult {
    const promo = winner.promotion;
    if (promo.discountType === 'PERCENTAGE') {
      return {
        itemId,
        promotionId: promo.id,
        discountType: 'percentage',
        discountValue: clampPercentageToSafeRange(promo.discountValue ?? 1),
        discountTitle: promo.title,
      };
    }
    return {
      itemId,
      promotionId: promo.id,
      discountType: 'amount',
      discountValue: promo.discountValue ?? 0,
      discountTitle: promo.title,
    };
  }

  // ============================================================
  // Per-sale (ORDER_DISCOUNT) best-wins
  // ============================================================

  private pickBestOrderPromo(
    candidates: ReadonlyArray<Promotion>,
    input: PosEvalInput,
    prePromoSubtotalCents: number,
    postLineSubtotalCents: number,
  ): PosEvalOrderResult | null {
    const eligible: Array<{
      promotion: Promotion;
      discountCents: number;
    }> = [];

    for (const promo of candidates) {
      if (promo.type !== 'ORDER_DISCOUNT') continue;

      // Symmetric to pickBestPerLine: MANUAL only when opted-in, and
      // ALSO skip MANUAL ids in the veto set so legacy corrupt drafts
      // (same id opted-in AND vetoed) self-heal on the next recompute.
      if (promo.method === 'MANUAL') {
        if (!input.optedInManualPromotionIds.includes(promo.id)) continue;
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      } else {
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      }

      if (!this.passesPromotionWideGates(promo, input)) continue;

      // minPurchaseAmountCents gate — against the draft's pre-promo subtotal.
      if (promo.minPurchaseAmountCents != null) {
        if (prePromoSubtotalCents < promo.minPurchaseAmountCents) continue;
      }

      const subtotal = postLineSubtotalCents;
      if (subtotal <= 0) continue;

      const discountCents = this.computeOrderDiscountCents(promo, subtotal);
      if (discountCents <= 0) continue;

      eligible.push({ promotion: promo, discountCents });
    }

    if (eligible.length === 0) return null;
    const winner = this.pickBestByMaxDiscountThenLowestIdForOrder(eligible);

    return {
      promotionId: winner.promotion.id,
      discountType:
        winner.promotion.discountType === 'PERCENTAGE'
          ? 'percentage'
          : 'amount',
      discountValue:
        winner.promotion.discountType === 'PERCENTAGE'
          ? clampPercentageToSafeRange(winner.promotion.discountValue ?? 1)
          : (winner.promotion.discountValue ?? 0),
      discountTitle: winner.promotion.title,
      discountAmountCents: winner.discountCents,
    };
  }

  private computeOrderDiscountCents(
    promo: Promotion,
    postLineSubtotalCents: number,
  ): number {
    if (promo.discountType == null || promo.discountValue == null) return 0;

    if (promo.discountType === 'PERCENTAGE') {
      const safePercent = clampPercentageToSafeRange(promo.discountValue);
      return Math.round((postLineSubtotalCents * safePercent) / 100);
    }
    // FIXED — cannot exceed the remaining subtotal.
    if (!Number.isInteger(promo.discountValue) || promo.discountValue <= 0) {
      return 0;
    }
    return Math.min(promo.discountValue, postLineSubtotalCents);
  }

  private pickBestByMaxDiscountThenLowestIdForOrder(
    candidates: ReadonlyArray<{ promotion: Promotion; discountCents: number }>,
  ): { promotion: Promotion; discountCents: number } {
    let best: { promotion: Promotion; discountCents: number } | null = null;
    for (const c of candidates) {
      if (
        best === null ||
        c.discountCents > best.discountCents ||
        (c.discountCents === best.discountCents &&
          c.promotion.id < best.promotion.id)
      ) {
        best = c;
      }
    }
    // Non-null because the caller checks `length > 0` first.
    return best as { promotion: Promotion; discountCents: number };
  }

  // ============================================================
  // Per-line BUY_X_GET_Y pass (WU3 — design.md Decision 3; spec.md:21-37,60-96)
  // ============================================================

  /**
   * Per-line BUY_X_GET_Y pass with cross-type TOTAL-saving best-wins.
   *
   * For each line already considered by the per-line PRODUCT_DISCOUNT
   * pass, evaluate every eligible BXGY promotion. If a BXGY candidate
   * beats the existing PD line result by TOTAL saving (per-line
   * cents, NOT per-unit), the line result is REPLACED by a
   * discriminated `kind:'buy-x-get-y'` result carrying the
   * whole-line reward `R`. Otherwise the existing per-unit PD result
   * stays in place — no stacking, exactly one applied result per line.
   *
   * Invariants:
   *   - `hasManualDiscount` short-circuit (mirrors `pickBestPerLine :419`)
   *     — AUTOMATIC BXGY skips a line with a seller free-form discount.
   *   - MANUAL gating symmetric to `pickBestPerLine (:431-437)`:
   *     MANUAL only when opted-in; both MANUAL opted-in AND vetoed
   *     self-heal on next recompute (veto wins).
   *   - `passesPromotionWideGates` — date window, daysOfWeek,
   *     customerScope, supported engine type.
   *   - `matchTargetTier != null` — BXGY targets the line's resolved
   *     productId/variantId/categoryId/brandId (same matcher as PD).
   *   - Price-list gate — `line.appliedGlobalPriceListId` must be in
   *     `promo.priceLists` when the promo is restricted (C1 fix).
   *   - `lineDiscountCents > 0` — the helper yields 0 reward when
   *     `qty < N+M` (Q9); the engine silently skips such lines.
   *
   * Mutates `lineResults` in place (replaces by itemId on BXGY win).
   */
  private evaluateBuyXGetYPass(
    lines: ReadonlyArray<PosEvalLine>,
    candidates: ReadonlyArray<Promotion>,
    input: PosEvalInput,
    lineResults: PosEvalLineResult[],
  ): void {
    for (const line of lines) {
      // Manual free-form discount wins — AUTO BXGY skips this line
      // (mirrors `pickBestPerLine` short-circuit at use-case.ts:419).
      if (line.hasManualDiscount) continue;

      // Locate the existing PD result for this line (if any) so the
      // comparator can subtract its per-line TOTAL saving.
      const existingIndex = lineResults.findIndex(
        (r) => r.itemId === line.itemId,
      );
      const existingPd =
        existingIndex >= 0 && lineResults[existingIndex].kind !== 'buy-x-get-y'
          ? lineResults[existingIndex]
          : null;

      // Find the best BXGY candidate for this line (if any). Mirrors
      // `pickBestPerLine` gating: MANUAL opt-in, veto, promotion-wide
      // gates, target match, price-list gate, helper yield > 0.
      const bxgyWinner = this.pickBestBuyXGetYPerLine(line, candidates, input);
      if (!bxgyWinner) continue;

      // Cross-type TOTAL-saving comparator (Q5 REVISED). The PD side
      // is multiplied by line.quantity to get the line-total PD
      // saving — `computeAppliedDiscountCents` returns per-unit by
      // design (it mirrors what `applyDiscount` consumes).
      const pdPerUnitCents = existingPd
        ? this.computeAppliedDiscountCents(line, existingPd)
        : 0;
      const pdTotalCents = pdPerUnitCents * line.quantity;
      const bxgyTotalCents = bxgyWinner.lineDiscountCents;

      const bxgyWins =
        bxgyTotalCents > pdTotalCents ||
        (bxgyTotalCents === pdTotalCents &&
          (existingPd === null
            ? true
            : bxgyWinner.promotion.id < existingPd.promotionId));

      if (!bxgyWins) continue;

      // Replace the existing per-unit PD result (if any) with the
      // discriminated BXGY result. No stacking — one result per line.
      const bxgyResult: PosEvalLineResult = {
        kind: 'buy-x-get-y',
        itemId: line.itemId,
        promotionId: bxgyWinner.promotion.id,
        discountTitle: bxgyWinner.promotion.title,
        lineDiscountCents: bxgyWinner.lineDiscountCents,
        perUnitRewardCents: bxgyWinner.perUnitRewardCents,
        discountedUnitCount: bxgyWinner.discountedUnitCount,
        getDiscountPercent: bxgyWinner.getDiscountPercent,
      };
      if (existingIndex >= 0) {
        lineResults[existingIndex] = bxgyResult;
      } else {
        lineResults.push(bxgyResult);
      }
    }
  }

  /**
   * Per-line BUY_X_GET_Y candidate collector + best-wins. Mirrors
   * `pickBestPerLine` for the gating layers (MANUAL opt-in / veto,
   * promotion-wide gates, target match, price-list gate) but ranks
   * candidates by the helper's LINE-TOTAL reward `R` instead of
   * per-unit. Ties resolve to lowest `promotion.id` — symmetric with
   * the per-unit best-wins branch.
   *
   * Returns `null` when:
   *   - `line.hasManualDiscount` is true (mirrors use-case.ts:419).
   *   - No BXGY candidate passes the gates.
   *   - The helper yields `lineDiscountCents === 0` for every eligible
   *     candidate (qty < N+M for all of them — Q9 silent skip).
   */
  private pickBestBuyXGetYPerLine(
    line: PosEvalLine,
    candidates: ReadonlyArray<Promotion>,
    input: PosEvalInput,
  ): {
    promotion: Promotion;
    lineDiscountCents: number;
    perUnitRewardCents: number;
    discountedUnitCount: number;
    getDiscountPercent: number;
  } | null {
    if (line.hasManualDiscount) return null;

    type BxgyCandidate = {
      promotion: Promotion;
      lineDiscountCents: number;
      perUnitRewardCents: number;
      discountedUnitCount: number;
      getDiscountPercent: number;
    };

    const eligible: BxgyCandidate[] = [];
    for (const promo of candidates) {
      if (promo.type !== 'BUY_X_GET_Y') continue;

      // MANUAL opt-in / veto gating — symmetric with pickBestPerLine.
      if (promo.method === 'MANUAL') {
        if (!input.optedInManualPromotionIds.includes(promo.id)) continue;
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      } else {
        if (input.vetoedPromotionIds.includes(promo.id)) continue;
      }

      if (!this.passesPromotionWideGates(promo, input)) continue;

      // BXGY requires a valid target tier on the line (Q1).
      const tier = matchTargetTier(promo.targetItems, line);
      if (tier === null) continue;

      // Price-list gate (C1 fix) — same membership predicate as PD.
      if (promo.priceLists.length > 0) {
        const globalId = line.appliedGlobalPriceListId;
        if (globalId == null) continue;
        const allowed = promo.priceLists.some(
          (pl) => pl.globalPriceListId === globalId,
        );
        if (!allowed) continue;
      }

      // Engine pre-gate on `qty >= buyQuantity` (spec.md:60-67). The
      // helper itself also handles qty < N+M → zero reward (Q9), but
      // the engine pre-gate avoids the helper call for the common
      // below-threshold case AND aligns the eligibility with spec
      // scenario :64-67.
      if (
        promo.buyQuantity == null ||
        promo.getQuantity == null ||
        promo.getDiscountPercent == null
      ) {
        continue;
      }
      if (line.quantity < promo.buyQuantity) continue;

      const reward = computeBuyXGetYReward({
        quantity: line.quantity,
        effectiveUnitPriceCents: line.effectiveUnitPriceCents,
        buyQuantity: promo.buyQuantity,
        getQuantity: promo.getQuantity,
        getDiscountPercent: promo.getDiscountPercent,
      });
      if (reward.lineDiscountCents <= 0) continue;

      eligible.push({
        promotion: promo,
        lineDiscountCents: reward.lineDiscountCents,
        perUnitRewardCents: reward.perUnitRewardCents,
        discountedUnitCount: reward.discountedUnitCount,
        // Narrowed non-null by the pre-gate above (promo.getDiscountPercent != null).
        getDiscountPercent: promo.getDiscountPercent,
      });
    }

    if (eligible.length === 0) return null;

    // Per-line best-wins: max line-total saving, ties → lowest id.
    let best: BxgyCandidate | null = null;
    for (const c of eligible) {
      if (
        best === null ||
        c.lineDiscountCents > best.lineDiscountCents ||
        (c.lineDiscountCents === best.lineDiscountCents &&
          c.promotion.id < best.promotion.id)
      ) {
        best = c;
      }
    }
    return best;
  }

  /**
   * WU4 — Per-line ADVANCED pass with cross-type TOTAL-saving best-wins.
   *
   * The first cross-line pass: BUY-side matches are aggregated across
   * the whole draft (D1), reward groups = floor(totalBuyMatchedQty /
   * buyQuantity) (D2), and the resulting reward units are allocated
   * across GET-side candidate lines sorted by `itemId` asc (spec
   * resolution — deterministic allocation; cheapest-first deferred).
   *
   * For each GET-side line that receives reward units, the existing
   * line result (PD or BXGY) is REPLACED by a discriminated
   * `kind:'advanced'` result carrying the per-line reward `R =
   * lineDiscountCents`. The comparator extends the BXGY 2-way rule
   * to a 3-way cross-type max on `lineTotalSavingCents`:
   *
   *   pdTotalCents      = existingPd.per-unit * line.quantity
   *   bxgyTotalCents    = existingBXGY.lineDiscountCents
   *   advancedTotalCents = advancedWinner.lineDiscountCents
   *
   * ADVANCED wins IFF advancedTotalCents > max(pdTotalCents, bxgyTotalCents)
   *   OR (tie && advancedId < best-existing-id).
   *
   * Invariants:
   *   - AUTOMATIC only: MANUAL ADVANCED is silently skipped (D6) — the
   *     gate at `isSupportedEngineType` admits only AUTOMATIC by
   *     construction (MANUAL ADVANCED is never considered). The
   *     manual surface / availableManualPromotions is NOT extended.
   *   - `hasManualDiscount` short-circuit: AUTO ADVANCED skips a line
   *     with a seller free-form discount — mirrors `pickBestPerLine`.
   *   - BUY side must aggregate >= buyQuantity to trigger any reward
   *     (D2); otherwise no result.
   *   - At least one GET-side line must exist (D4 degenerate-cart
   *     rule, S4 spec scenario) — otherwise no result.
   *   - Intakerejects same-entity BUY/GET (D7) — engine sees only
   *     disjoint target lists, so no cart line matches both sides.
   *
   * Mutates `lineResults` in place (replaces by itemId on ADVANCED win).
   */
  private evaluateAdvancedPass(
    lines: ReadonlyArray<PosEvalLine>,
    candidates: ReadonlyArray<Promotion>,
    input: PosEvalInput,
    lineResults: PosEvalLineResult[],
  ): void {
    for (const promo of candidates) {
      if (promo.type !== 'ADVANCED') continue;
      // D6 — AUTOMATIC only. MANUAL ADVANCED is silently skipped
      // (no manual surface for ADVANCED in this slice). The gate
      // below also filters MANUAL via veto list (symmetric with the
      // other branches), but the explicit check pins D6 semantics.
      if (promo.method !== 'AUTOMATIC') continue;
      // Veto set (symmetric with the other per-line branches): AUTO
      // ADVANCED is excluded when the seller vetoed this promo id.
      if (input.vetoedPromotionIds.includes(promo.id)) continue;
      // Promotion-wide gates — date window, daysOfWeek, customerScope,
      // supported engine type (null target types rejected).
      // Spec.md:43-55 — null or unsupported buy/get target types
      // silently skip the candidate.
      if (!this.passesPromotionWideGates(promo, input)) continue;
      // The price-list gate is irrelevant for ADVANCED (it has no
      // `appliesTo` and the engine does not consult `priceLists` for
      // ADVANCED in this slice).
      if (promo.buyQuantity == null || promo.getQuantity == null || promo.getDiscountPercent == null) {
        continue;
      }

      // D1 — aggregated BUY-side quantity across the draft.
      let totalBuyMatchedQty = 0;
      for (const line of lines) {
        if (line.hasManualDiscount) continue;
        if (matchTargetTier(promo.targetItems, line, 'BUY') === null) continue;
        totalBuyMatchedQty += line.quantity;
      }

      // D2 — per-group reward repeatability.
      const rewardGroupCount = Math.floor(
        totalBuyMatchedQty / promo.buyQuantity,
      );
      if (rewardGroupCount === 0) continue;

      // S4 — degenerate-cart guard. If no line matches a GET-side
      // target, the helper has nothing to allocate. Skip.
      const getCandidateLines: Array<{
        itemId: string;
        effectiveUnitPriceCents: number;
        quantity: number;
      }> = [];
      for (const line of lines) {
        if (line.hasManualDiscount) continue;
        if (matchTargetTier(promo.targetItems, line, 'GET') === null) continue;
        getCandidateLines.push({
          itemId: line.itemId,
          effectiveUnitPriceCents: line.effectiveUnitPriceCents,
          quantity: line.quantity,
        });
      }
      if (getCandidateLines.length === 0) continue;

      // Pure helper (mirrors computeBuyXGetYReward but multi-GET-line).
      const { rewards } = computeAdvancedReward({
        totalBuyMatchedQty,
        buyQuantity: promo.buyQuantity,
        getQuantity: promo.getQuantity,
        getDiscountPercent: promo.getDiscountPercent,
        getCandidateLines,
      });

      // Apply each reward to its line via the 3-way cross-type
      // comparator. Replaces the existing PD / BXGY result on win.
      for (const reward of rewards) {
        const targetLine = lines.find((l) => l.itemId === reward.itemId);
        if (!targetLine) continue;

        const existingIndex = lineResults.findIndex(
          (r) => r.itemId === reward.itemId,
        );
        const existing =
          existingIndex >= 0 ? lineResults[existingIndex] : null;
        const existingTotal = this.existingLineResultTotalCents(
          targetLine,
          existing,
        );

        // Cross-type 3-way comparator. ADVANCED wins iff its line-total
        // saving > the best existing line-total saving, OR a tie
        // resolved by lowest promotionId.
        const advancedWins =
          reward.lineDiscountCents > existingTotal ||
          (reward.lineDiscountCents === existingTotal &&
            (existing === null
              ? true
              : promo.id < (existing as { promotionId: string }).promotionId));

        if (!advancedWins) continue;

        const advancedResult: PosEvalLineResult = {
          kind: 'advanced',
          itemId: reward.itemId,
          promotionId: promo.id,
          discountTitle: promo.title,
          lineDiscountCents: reward.lineDiscountCents,
          perUnitRewardCents: reward.perUnitRewardCents,
          discountedUnitCount: reward.discountedUnitCount,
          getDiscountPercent: promo.getDiscountPercent,
        };

        if (existingIndex >= 0) {
          lineResults[existingIndex] = advancedResult;
        } else {
          lineResults.push(advancedResult);
        }
      }
    }
  }

  /**
   * WU4 helper — return the line-total saving cents for the existing
   * line result, used by the ADVANCED 3-way comparator. Mirrors the
   * shape `pickBestBuyXGetYPerLine` produces for the existing PD
   * result (per-unit × qty) and `computeAppliedDiscountCents`
   * already produces for the BXGY shape (whole-line). Falls back to
   * `existingTotal = 0` when no prior result is present.
   */
  private existingLineResultTotalCents(
    line: PosEvalLine,
    existing: PosEvalLineResult | null,
  ): number {
    if (existing === null) return 0;
    if (existing.kind === 'buy-x-get-y' || existing.kind === 'advanced') {
      // Whole-line reward — no multiplication needed.
      return existing.lineDiscountCents;
    }
    // Per-unit PD result.
    return this.computeAppliedDiscountCents(line, existing) * line.quantity;
  }

  /**
   * Compute the per-line discount the entity-side `applyDiscount`
   * would produce given the emitted result. Used to compute the
   * post-line-discount subtotal feeding ORDER_DISCOUNT best-wins.
   * Matches the math used in `pickBestPerLine`.
   *
   * WU3 (buy-x-get-y) — discriminated `PosEvalLineResult`: when the
   * winning result is BXGY (kind === 'buy-x-get-y'), the LINE-TOTAL
   * reward `R = lineDiscountCents` is returned verbatim. The BXGY
   * path bypasses `SaleItem.applyDiscount` entirely (its 1..99%
   * clamp and the `baseline − discount >= 1` invariant are NOT on
   * the BXGY path), so we MUST return the whole-line number here
   * (NOT per-unit × qty) — design.md Decision 1 + Decision 3.
   */
  private computeAppliedDiscountCents(
    line: PosEvalLine,
    result: PosEvalLineResult,
  ): number {
    if (result.kind === 'buy-x-get-y' || result.kind === 'advanced') {
      // BXGY / ADVANCED: `lineDiscountCents` IS the per-line total reward R.
      // Both discriminated shapes share the same line-total reward
      // shape (design.md Decision 1 + WU2). The wire `rewardKind`
      // discriminator ('buy_x_get_y' vs 'advanced') is added in
      // Slice 2 (WU5) — this engine stage is shape-agnostic.
      return result.lineDiscountCents;
    }
    if (result.discountType === 'percentage') {
      // Same clamp + Math.round as the ranking path.
      const percent = clampPercentageToSafeRange(result.discountValue);
      return Math.round((line.effectiveUnitPriceCents * percent) / 100);
    }
    // FIXED amount — capped at baseline.
    return Math.min(result.discountValue, line.effectiveUnitPriceCents);
  }
}
