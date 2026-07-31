import { IsInt, Min } from 'class-validator';

/**
 * Body for `PATCH /quotations/drafts/:id/items/:itemId/quantity`.
 *
 * WU3 — Update the quantity of an existing item in a DRAFT quotation.
 * The entity's `updateItemQuantity` rejects `quantity < 1` (the spec
 * scenario "Quantity zero is rejected with 400" maps to a 400 via
 * `InvalidArgumentError` in the DomainExceptionFilter).
 */
export class UpdateQuotationItemQuantityDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}
