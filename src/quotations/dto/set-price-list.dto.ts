import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * Body for `PUT /quotations/drafts/:id/price-list`.
 *
 * WU2 — Cashier-explicit quotation-level price-list binding. Mirrors
 * `sales/dto/set-price-list.dto.ts` so future FE clients can reuse a
 * single shared DTO shape:
 *   - present (UUID) → cashier explicitly binds the draft to that list.
 *   - null            → cashier explicitly clears the binding (the
 *                      `priceListExplicitlySet` discriminator still
 *                      flips to true; future `assignCustomer` calls do
 *                      NOT re-seed the list).
 *
 * Validation:
 *   - if a string is present → must be a UUID.
 *   - if absent / null       → round-trips to a null store. We accept
 *     both `undefined` (the JSON body omits the field) and explicit
 *     `null` (the body sends `"globalPriceListId": null`).
 */
export class SetPriceListDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  globalPriceListId?: string | null;
}
