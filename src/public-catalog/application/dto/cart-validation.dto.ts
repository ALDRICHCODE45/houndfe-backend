import type { PublicStockStatus } from '../../domain/types';

export type CartWarningCode =
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'LOW_STOCK'
  | 'PRICE_HIDDEN'
  | 'NOT_FOUND'
  | 'NOT_IN_CATALOG'
  | 'VARIANT_NOT_FOUND';

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
