import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * Body for `POST /quotations/drafts/:id/items`.
 *
 * WU3 — Add an item to a DRAFT quotation. The service resolves the
 * product/variant via `ProductsService.getProductInfoForSale` and
 * snapshots the default PUBLICO price + display names. The
 * recompute pipeline (reprice + engine) re-resolves the price when
 * a price list is bound.
 *
 * No stock check — the spec requirement "Stock Checks Bypassed" is
 * enforced by the service's absence of `checkStockAvailability`.
 */
export class AddQuotationItemDto {
  @IsString()
  productId!: string;

  @IsOptional()
  @IsString()
  variantId?: string | null;

  @IsNumber()
  @Min(1)
  quantity!: number;
}
