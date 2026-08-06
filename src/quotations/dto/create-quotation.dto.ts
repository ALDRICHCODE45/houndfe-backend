import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * Body for `POST /quotations/drafts`.
 *
 * WU2 — Open a new DRAFT quotation. Both fields are optional:
 *   - omitted       → creates a fresh draft with no customer / price list.
 *   - `customerId`  → seeds the draft with the given customer (and
 *                      auto-seeds `globalPriceListId` from the customer's
 *                      default list inside the service layer).
 *   - `globalPriceListId` → binds the draft to a specific list (the
 *                      cashier's explicit choice; subsequent
 *                      `assignCustomer` MUST NOT re-seed).
 */
export class CreateQuotationDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  globalPriceListId?: string | null;
}
