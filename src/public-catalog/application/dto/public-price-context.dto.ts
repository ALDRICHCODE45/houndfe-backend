import type { PublicCatalogProductDetail } from './public-product-detail.dto';

/**
 * F2.WU6 slice 4b — exact public price-context metadata attached to a
 * context-mapped public detail response. Sourced only from the already
 * resolved `ResolvedPublicCatalogContext`; never exposes tenant ID or slug.
 */
export interface PublicPriceContextDto {
  /** Selected public price-list ID (the context's `globalPriceListId`). */
  priceListId: string;
  /** Human-readable price-context name. */
  name: string;
  /** True when the context is the tenant's catalog default. */
  isCatalogDefault: boolean;
}

/**
 * F2.WU6 slice 4b — dormant context-explicit public product detail
 * response. Flatly extends the existing product body (canonical design:
 * "Detail extends the existing product body with") with exact public
 * price-context metadata and a literal `excludedCount: 0` — the mapping
 * is exact-selected-only and never rewrites prices, so nothing is
 * excluded at this layer. No production caller yet; HTTP activation
 * stays in Slice 5.
 */
export interface PublicCatalogProductDetailWithContextDto extends PublicCatalogProductDetail {
  priceContext: PublicPriceContextDto;
  excludedCount: 0;
}
