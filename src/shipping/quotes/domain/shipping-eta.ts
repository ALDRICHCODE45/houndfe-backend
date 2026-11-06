/**
 * shipping-zones / T3 (S9) — "Base + ajustes".
 *
 * The base is the zone's usual days (own delivery) or the carrier ETA. When a
 * line lacks sellable stock now, the quote does not promise that time: the bot
 * asks RESTOCK (`restockDays`) and tells the customer restockDays + base.
 */

export type QuoteEtaReason = 'STOCK_PENDING';

export interface QuoteEta {
  days: number | null;
  reason: QuoteEtaReason | null;
}

export function resolveQuoteEta(
  baseDays: number | null,
  stockPending: boolean,
): QuoteEta {
  return stockPending
    ? { days: null, reason: 'STOCK_PENDING' }
    : { days: baseDays, reason: null };
}
