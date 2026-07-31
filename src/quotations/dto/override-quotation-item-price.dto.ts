import { IsInt, Min } from 'class-validator';

/**
 * Body for `PATCH /quotations/drafts/:id/items/:itemId/price`.
 *
 * WU3 — Override the unit price of an existing item in a DRAFT
 * quotation. The service sets `priceSource = 'CUSTOM'` so subsequent
 * recomputes skip the line (sticky). The unit price is an integer
 * (cents) — `@Min(1)` rejects zero/negative prices.
 */
export class OverrideQuotationItemPriceDto {
  @IsInt()
  @Min(1)
  unitPriceCents!: number;
}
