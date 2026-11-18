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
 */
export interface EngineAppliedPromotions {
  lines: ReadonlyArray<{ promotionId: string }>;
  order: { promotionId: string } | null;
}

export function promotionsToVetoForExactOpening(
  applied: EngineAppliedPromotions,
  alreadyVetoed: ReadonlyArray<string>,
): string[] {
  const vetoed = new Set(alreadyVetoed);
  const result: string[] = [];
  const candidates = [
    ...applied.lines.map((line) => line.promotionId),
    ...(applied.order ? [applied.order.promotionId] : []),
  ];
  for (const id of candidates) {
    if (vetoed.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}
