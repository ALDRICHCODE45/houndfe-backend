/**
 * quotation-sale-conversion / T2 (S8) — "Exacto por defecto, se ajusta
 * después": a sale opened from a quotation must total exactly the quote.
 *
 * Pure rule: given what the promotion engine would apply to the freshly
 * built draft, return the promotion ids that must be added to the sale's
 * veto set (line promotions of any kind + the ORDER promotion), skipping
 * ids already vetoed. Vetoing (instead of dropping the promotion silently)
 * keeps them re-enableable by the cashier through the existing draft
 * routes.
 *
 * T3 (S8, defect D2) — a quoted line discount that came from a promotion
 * the sale engine still reproduces EXACTLY is kept as that promotion's
 * line application (not a manual discount), so later order promotions are
 * computed on the subtotal net of it, like in a normal sale. `kept` ids are
 * never vetoed; `keptQuotedPromotionMismatches` tells the caller which kept
 * ids did not reproduce the quote and must fall back to a manual discount.
 */
import type { SaleItemProps } from './sale-item.entity';

export interface EngineAppliedPromotions {
  lines: ReadonlyArray<{ promotionId: string }>;
  order: { promotionId: string } | null;
}

export function promotionsToVetoForExactOpening(
  applied: EngineAppliedPromotions,
  alreadyVetoed: ReadonlyArray<string>,
  kept: ReadonlySet<string> = new Set(),
): string[] {
  const vetoed = new Set(alreadyVetoed);
  const result: string[] = [];
  const candidates = [
    ...applied.lines.map((line) => line.promotionId),
    ...(applied.order ? [applied.order.promotionId] : []),
  ];
  for (const id of candidates) {
    if (vetoed.has(id) || kept.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

type OpeningLineProps = Omit<SaleItemProps, 'id' | 'saleId'>;

/**
 * The converted line before its quoted discount: same sticky custom gross
 * price, no discount, so the engine can re-apply the quoted promotion.
 */
export function withoutQuotedDiscount(
  line: OpeningLineProps,
): OpeningLineProps {
  return {
    ...line,
    unitPriceCents: line.prePriceCentsBeforeDiscount ?? line.unitPriceCents,
    discountType: null,
    discountValue: null,
    discountAmountCents: null,
    prePriceCentsBeforeDiscount: null,
    discountTitle: null,
    discountedAt: null,
    promotionId: null,
  };
}

/** A quoted line whose discount is kept as its promotion's application. */
export interface KeptQuotedPromotionLine {
  itemId: string;
  promotionId: string;
  /** Quoted NET unit price. */
  unitPriceCents: number;
  /** Quoted per-unit discount. */
  discountAmountCents: number;
}

export interface OpenedSaleLine {
  id: string;
  promotionId: string | null;
  unitPriceCents: number;
  discountAmountCents: number | null;
  isReward: boolean;
}

/**
 * Kept promotion ids that did NOT reproduce the quote after the recompute:
 * an expected line misses the promotion or got a different amount, or the
 * promotion landed on a line that did not quote it.
 */
export function keptQuotedPromotionMismatches(
  items: ReadonlyArray<OpenedSaleLine>,
  expected: ReadonlyArray<KeptQuotedPromotionLine>,
  kept: ReadonlySet<string>,
): string[] {
  const mismatched = new Set<string>();
  const expectedByItemId = new Map<string, KeptQuotedPromotionLine>();
  for (const line of expected) {
    if (!kept.has(line.promotionId)) continue;
    expectedByItemId.set(line.itemId, line);
    const item = items.find((i) => i.id === line.itemId);
    if (
      !item ||
      item.isReward ||
      item.promotionId !== line.promotionId ||
      item.unitPriceCents !== line.unitPriceCents ||
      item.discountAmountCents !== line.discountAmountCents
    ) {
      mismatched.add(line.promotionId);
    }
  }
  for (const item of items) {
    if (item.promotionId === null || !kept.has(item.promotionId)) continue;
    if (expectedByItemId.get(item.id)?.promotionId !== item.promotionId) {
      mismatched.add(item.promotionId);
    }
  }
  return [...mismatched];
}
