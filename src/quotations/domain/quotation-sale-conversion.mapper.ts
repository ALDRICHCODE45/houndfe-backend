/**
 * quotation-sale-conversion / T1 — pure line mapping between a POS DRAFT
 * sale and a quotation, in both directions. No I/O: catalog facts and
 * promotion titles are resolved by the application service and passed in.
 *
 * Sale DRAFT → quotation (S2: "precio vigente"):
 *   - plain list line (`default` / `price_list`) → `PRICE_LIST` line at its
 *     pre-discount base, keeping a per-item `appliedPriceListId` override.
 *     The quotation recompute then re-resolves the current list/tier price
 *     and re-evaluates promotions (engine context `QUOTATION`).
 *   - cashier custom price → `CUSTOM` (sticky) at the same unit price.
 *   - manual free-form discount (line or global) → `CUSTOM` at the
 *     DISCOUNTED unit price. Quotations cannot carry a manual discount
 *     breakdown, so the net price is preserved, the breakdown is not.
 *   - promotion per-unit discount → pre-discount base; the promotion is
 *     re-evaluated on the quotation (opt-ins / vetoes are copied by the
 *     service). If it does not re-apply it is reported as dropped.
 *   - BUY_X_GET_Y / ADVANCED whole-line reward and the sale-level ORDER
 *     promotion → NOT representable on a quotation; reported as dropped.
 *
 * Quotation → sale DRAFT (S5: quoted prices and discounts kept):
 *   - every line becomes a sticky `custom` sale line priced at the quoted
 *     gross unit price (`unitPriceCents + discountAmountCents`).
 *   - a quoted per-unit discount becomes a MANUAL sale discount
 *     (`promotionId = null`) with the exact quoted cents, so the sale
 *     recompute never strips or re-prices it.
 */
import type { SaleItemProps } from '../../sales/domain/sale-item.entity';

/** The sale line fields the mapping reads (a `SaleItem` satisfies it). */
export interface SaleLineSnapshot {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPriceCents: number;
  prePriceCentsBeforeDiscount: number | null;
  priceSource: 'default' | 'price_list' | 'custom';
  appliedPriceListId: string | null;
  discountType: 'amount' | 'percentage' | null;
  discountValue: number | null;
  discountAmountCents: number | null;
  discountTitle: string | null;
  promotionId: string | null;
  rewardKind: 'buy_x_get_y' | 'advanced' | null;
}

/** Quotation line seed produced from a sale line (ids added by the caller). */
export interface QuotationLineDraft {
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPriceCents: number;
  priceSource: 'PRICE_LIST' | 'CUSTOM';
  appliedPriceListId: string | null;
  customPriceCents: number | null;
}

/** An adjustment present on the sale that the quotation does not carry. */
export interface DroppedSaleAdjustment {
  kind: 'ORDER_PROMOTION' | 'REWARD_PROMOTION' | 'LINE_PROMOTION';
  saleItemId: string | null;
  productId: string | null;
  variantId: string | null;
  promotionId: string | null;
  title: string | null;
  /** Total cents the customer no longer saves because of this drop. */
  discountCents: number;
}

/** The quoted line fields the mapping reads (a `QuotationItem` satisfies it). */
export interface QuotedLineSnapshot {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** NET quoted unit price (after the per-unit discount). */
  unitPriceCents: number;
  discountType: 'amount' | 'percentage' | null;
  discountValue: number | null;
  /** Per-unit discount in cents (0 when none). */
  discountAmountCents: number;
  promotionId: string | null;
}

/** Fallback title for a quoted discount whose promotion no longer exists. */
export const QUOTED_DISCOUNT_FALLBACK_TITLE = 'Descuento cotizado';

/** Whole-line BXGY / ADVANCED reward (mirrors `SaleItem.isBuyXGetYReward`). */
export function isRewardLine(line: SaleLineSnapshot): boolean {
  if (line.rewardKind !== null) return true;
  return (
    line.promotionId !== null &&
    line.prePriceCentsBeforeDiscount !== null &&
    line.prePriceCentsBeforeDiscount === line.unitPriceCents &&
    (line.discountAmountCents ?? 0) > 0
  );
}

/** Manual free-form discount (line or global): discount without promotion. */
export function hasManualDiscount(line: SaleLineSnapshot): boolean {
  return line.discountType !== null && line.promotionId === null;
}

export function mapSaleLineToQuotationLine(
  line: SaleLineSnapshot,
): QuotationLineDraft {
  const identity = {
    productId: line.productId,
    variantId: line.variantId,
    quantity: line.quantity,
  };

  if (hasManualDiscount(line)) {
    return {
      ...identity,
      unitPriceCents: line.unitPriceCents,
      priceSource: 'CUSTOM',
      appliedPriceListId: null,
      customPriceCents: line.unitPriceCents,
    };
  }

  // Reward lines keep `unitPriceCents` FULL (prePrice === unitPrice), so
  // the base below is the full unit price for them too.
  const baseCents = line.prePriceCentsBeforeDiscount ?? line.unitPriceCents;
  if (line.priceSource === 'custom') {
    return {
      ...identity,
      unitPriceCents: baseCents,
      priceSource: 'CUSTOM',
      appliedPriceListId: null,
      customPriceCents: baseCents,
    };
  }
  return {
    ...identity,
    unitPriceCents: baseCents,
    priceSource: 'PRICE_LIST',
    appliedPriceListId: line.appliedPriceListId,
    customPriceCents: null,
  };
}

/**
 * Everything the sale had that the resulting quotation does not: the
 * sale-level ORDER promotion, whole-line rewards, and per-unit promotions
 * the quotation engine did not re-apply to the same product/variant.
 */
export function computeDroppedSaleAdjustments(input: {
  saleLines: ReadonlyArray<SaleLineSnapshot>;
  appliedOrderPromotion: {
    promotionId: string | null;
    discountAmountCents: number;
    discountTitle: string | null;
  } | null;
  quotationLines: ReadonlyArray<{
    productId: string;
    variantId: string | null;
    promotionId: string | null;
  }>;
}): DroppedSaleAdjustment[] {
  const dropped: DroppedSaleAdjustment[] = [];

  if (
    input.appliedOrderPromotion &&
    input.appliedOrderPromotion.discountAmountCents > 0
  ) {
    dropped.push({
      kind: 'ORDER_PROMOTION',
      saleItemId: null,
      productId: null,
      variantId: null,
      promotionId: input.appliedOrderPromotion.promotionId,
      title: input.appliedOrderPromotion.discountTitle,
      discountCents: input.appliedOrderPromotion.discountAmountCents,
    });
  }

  for (const line of input.saleLines) {
    if (line.promotionId === null || (line.discountAmountCents ?? 0) <= 0) {
      continue;
    }
    const base = {
      saleItemId: line.id,
      productId: line.productId,
      variantId: line.variantId,
      promotionId: line.promotionId,
      title: line.discountTitle,
    };
    if (isRewardLine(line)) {
      dropped.push({
        kind: 'REWARD_PROMOTION',
        ...base,
        // Whole-line reward R rides `discountAmountCents` verbatim.
        discountCents: line.discountAmountCents ?? 0,
      });
      continue;
    }
    const reapplied = input.quotationLines.some(
      (q) =>
        q.productId === line.productId &&
        q.variantId === line.variantId &&
        q.promotionId === line.promotionId,
    );
    if (!reapplied) {
      dropped.push({
        kind: 'LINE_PROMOTION',
        ...base,
        discountCents: (line.discountAmountCents ?? 0) * line.quantity,
      });
    }
  }

  return dropped;
}

export type ConvertedSaleLine = Omit<SaleItemProps, 'id' | 'saleId'>;

export function mapQuotationLineToSaleLine(
  line: QuotedLineSnapshot,
  ctx: {
    productName: string;
    variantName: string | null;
    imageUrl: string | null;
    /** Title of `line.promotionId` when it still exists. */
    promotionTitle: string | null;
    now: Date;
  },
): ConvertedSaleLine {
  const discountCents = Math.max(0, line.discountAmountCents);
  const grossCents = line.unitPriceCents + discountCents;
  const hasDiscount = discountCents > 0;

  return {
    productId: line.productId,
    variantId: line.variantId,
    productName: ctx.productName,
    variantName: ctx.variantName,
    imageUrl: ctx.imageUrl,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    unitPriceCurrency: 'MXN',
    // Sticky: the sale reprice step never touches `custom` lines (S5).
    priceSource: 'custom',
    customPriceCents: grossCents,
    appliedPriceListId: null,
    originalPriceCents: null,
    discountType: hasDiscount ? (line.discountType ?? 'amount') : null,
    discountValue: hasDiscount ? (line.discountValue ?? discountCents) : null,
    discountAmountCents: hasDiscount ? discountCents : null,
    prePriceCentsBeforeDiscount: hasDiscount ? grossCents : null,
    discountTitle: hasDiscount
      ? (ctx.promotionTitle ?? QUOTED_DISCOUNT_FALLBACK_TITLE)
      : null,
    discountedAt: hasDiscount ? ctx.now : null,
    // Manual on the sale: the engine skips it and the clear step keeps it.
    promotionId: null,
  };
}
