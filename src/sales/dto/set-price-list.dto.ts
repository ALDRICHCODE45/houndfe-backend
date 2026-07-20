import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * WU3 — Body for `PUT /sales/drafts/:id/price-list` (POS Price List
 * Tiers endpoint).
 *
 * Carries a single optional `globalPriceListId`:
 *   - present (UUID) → cashier explicitly binds the sale to that list.
 *   - null            → cashier explicitly clears the binding. The
 *                      `priceListExplicitlySet` discriminator still
 *                      flips to true (an explicit null clear is the
 *                      cashier's choice, not a reseedable state).
 *
 * Validation:
 *   - if a string is present → must be a UUID.
 *   - if absent / null       → must round-trip to a null store. We
 *     accept both `undefined` (the JSON body omits the field) and
 *     explicit `null` (the body sends `"globalPriceListId": null`).
 *     Both routes are valid; the service layer is the source of truth
 *     on the meaning of each.
 */
export class SetPriceListDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  globalPriceListId?: string | null;
}
