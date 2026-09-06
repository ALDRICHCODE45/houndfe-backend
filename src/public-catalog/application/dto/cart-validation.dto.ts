import type { PublicStockStatus } from '../../domain/types';
import type { PublicPriceContextDto } from './public-price-context.dto';

export type CartWarningCode =
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'NOT_FOUND'
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_NOT_IN_CATALOG'
  | 'PRICE_NOT_AVAILABLE_IN_CONTEXT';

export interface CartValidatedItem {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  image: { url: string } | null;
  quantity: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  availability: PublicStockStatus;
  priceHidden: boolean;
  warnings: CartWarningCode[];
}

export interface CartValidationResponseDto {
  valid: boolean;
  items: CartValidatedItem[];
  totalCents: number | null;
  warnings: CartWarningCode[];
}

/**
 * F2.WU7 slice 2 — per-item blocking codes for contextual cart
 * reconciliation. `NOT_FOUND` and `PRICE_CHANGED` are intentionally absent:
 * contextual validation never distinguishes a missing product from an
 * excluded one, and client prices are never accepted.
 */
export type CartBlockingCode =
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_NOT_IN_CATALOG'
  | 'PRICE_NOT_AVAILABLE_IN_CONTEXT'
  | 'OUT_OF_STOCK';

/**
 * F2.WU7 slice 2 — dormant context-explicit validated item. Extends the
 * legacy item shape with explicit `status`/`blockingCodes`; `productName`
 * widens to nullable because blocked membership/publication rows are
 * redacted to `null` instead of an empty string.
 */
export type CartValidatedItemWithContextDto = Omit<
  CartValidatedItem,
  'productName'
> & {
  productName: string | null;
  status: 'VALID' | 'BLOCKED';
  blockingCodes: CartBlockingCode[];
};

/**
 * F2.WU7 slice 2 — dormant context-explicit cart response. Adds the exact
 * resolved `priceContext` on top of the legacy shape; `items` use the
 * contextual item type above. No production caller yet.
 */
export interface CartValidationResponseWithContextDto {
  valid: boolean;
  priceContext: PublicPriceContextDto;
  items: CartValidatedItemWithContextDto[];
  totalCents: number | null;
  warnings: CartWarningCode[];
}
