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
 * Tier returned by `matchTargetTier` — encodes BOTH "did the target
 * hit this line?" AND "which specificity won?" in a single value, so
 * the engine never needs a second predicate pass.
 *
 *   - 'VARIANT' : a VARIANTS-typed target hit the line's variantId.
 *   - 'PRODUCT' : no VARIANTS hit, but a PRODUCTS-typed target hit the
 *                 line's productId (back-compat: a PRODUCTS promo on
 *                 product P1 still matches EVERY variant of P1).
 *   - null      : no DEFAULT-side target hit the line.
 */
export type LineMatchTier = 'VARIANT' | 'PRODUCT' | null;

/**
 * Match predicate — pure, exported for both testability AND future
 * reuse (online/cart engine `evaluate-cart-promotions.use-case.ts`).
 *
 * Specificity rule: VARIANTS wins over PRODUCTS when both hit the
 * same line. The pre-pass in `pickBestPerLine` further drops any
 * tier='PRODUCT' candidate when ANY candidate for that line is
 * tier='VARIANT' (orthogonal filter; best-wins invariant untouched).
 */
export function matchTargetTier(
  targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
  line: { productId: string; variantId: string | null },
): LineMatchTier {
  const side = 'DEFAULT';
  // VARIANTS first — strict === null on variantId so an unset variant
  // never matches (defensive: structural guarantee).
  if (
    line.variantId != null &&
    targetItems.some(
      (ti) =>
        ti.side === side &&
        ti.targetType === 'VARIANTS' &&
        ti.targetId === line.variantId,
    )
  ) {
    return 'VARIANT';
  }
  if (
    targetItems.some(
      (ti) =>
        ti.side === side &&
        ti.targetType === 'PRODUCTS' &&
        ti.targetId === line.productId,
    )
  ) {
    return 'PRODUCT';
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
    const availableManualPromotions = candidates
      .filter(
        (promo) =>
          promo.method === 'MANUAL' &&
          this.passesPromotionWideGates(promo, input) &&
          this.isSupportedEngineType(promo) &&
          !input.vetoedPromotionIds.includes(promo.id) &&
          !input.optedInManualPromotionIds.includes(promo.id),
      )
      .map(
        (promo): PosEvalManualCandidate => ({
          id: promo.id,
          title: promo.title,
          type:
            promo.type === 'ORDER_DISCOUNT'
              ? 'ORDER_DISCOUNT'
              : 'PRODUCT_DISCOUNT',
          // The filter above already pinned `promo.method === 'MANUAL'`, so
          // this is a constant — exposed on the wire (b84aab7) so the
          // frontend can confirm the candidate is MANUAL before offering
          // opt-in. The Promotion.method enum also has AUTOMATIC, but that
          // branch never reaches this mapper.
          method: 'MANUAL',
        }),
      );

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
    //     - PRODUCT_DISCOUNT (appliesTo=PRODUCTS only — same gate as the
    //       line-ranker): included IFF at least one line in the cart
    //       matches `promo.targetItems` (side=DEFAULT,
    //       targetType=PRODUCTS, targetId=line.productId). The per-line
    //       price-list gate, `hasManualDiscount`, and best-wins loss
    //       are ALL "temporarily ineligible" — the target is still in
    //       the cart, so the opt-in is RETAINED.
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
      // PRODUCT_DISCOUNT (with appliesTo=PRODUCTS — isSupportedEngineType
      // already gated the other applyTo branches). At least one line in
      // the cart must match the target.
      if (promo.type === 'PRODUCT_DISCOUNT' && promo.appliesTo === 'PRODUCTS') {
        const hasMatchingLine = input.lines.some((line) =>
          promo.targetItems.some(
            (ti) =>
              ti.side === 'DEFAULT' &&
              ti.targetType === 'PRODUCTS' &&
              ti.targetId === line.productId,
          ),
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
    // CATEGORIES/BRANDS / BUY_X_GET_Y / ADVANCED are DEFERRED.
    if (promo.type === 'ORDER_DISCOUNT') return true;
    if (promo.type === 'PRODUCT_DISCOUNT' && promo.appliesTo === 'PRODUCTS') {
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

      // PRODUCT_DISCOUNT with appliesTo=PRODUCTS, only target DEFAULT side.
      if (promo.type !== 'PRODUCT_DISCOUNT') continue;
      if (promo.appliesTo !== 'PRODUCTS') continue;

      const targetsProduct = promo.targetItems.some(
        (ti) =>
          ti.side === 'DEFAULT' &&
          ti.targetType === 'PRODUCTS' &&
          ti.targetId === line.productId,
      );
      if (!targetsProduct) continue;

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

      eligible.push({ promotion: promo, discountCents });
    }

    if (eligible.length === 0) return null;
    return this.pickBestByMaxDiscountThenLowestId(eligible);
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

  /**
   * Compute the per-line discount the entity-side `applyDiscount`
   * would produce given the emitted result. Used to compute the
   * post-line-discount subtotal feeding ORDER_DISCOUNT best-wins.
   * Matches the math used in `pickBestPerLine`.
   */
  private computeAppliedDiscountCents(
    line: PosEvalLine,
    result: PosEvalLineResult,
  ): number {
    if (result.discountType === 'percentage') {
      // Same clamp + Math.round as the ranking path.
      const percent = clampPercentageToSafeRange(result.discountValue);
      return Math.round((line.effectiveUnitPriceCents * percent) / 100);
    }
    // FIXED amount — capped at baseline.
    return Math.min(result.discountValue, line.effectiveUnitPriceCents);
  }
}
