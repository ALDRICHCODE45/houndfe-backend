import type { PublicCatalogProductDetail, PublicVariantDto } from './public-product-detail.dto';
import type { PublicCatalogProductCard } from './public-product-card.dto';
import type { PublicCatalogCategoryFacet } from './public-category-facet.dto';
import type { PublicStockPresentationDto } from './public-stock-presentation.dto';
import type { PublicStockStatus } from '../../domain/types';

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
 * F3.WU9 slice 7 — contextual variant branch availability: the legacy shape
 * with a compatibility `availability` that mirrors the row's
 * `stockPresentation.status` and is `null` when the mode hides the indicator.
 */
export interface PublicContextualVariantAvailabilityDto {
  branchId: string;
  branchName: string;
  branchSlug: string;
  availability: PublicStockStatus | null;
  isSelected: boolean;
}

/**
 * F3.WU9 slice 7 — contextual variant row: the legacy public variant shape
 * plus its own presentation projection. Operational quantities stay absent.
 */
export interface PublicContextualVariantDto
  extends Omit<PublicVariantDto, 'availabilityByBranch'> {
  availabilityByBranch: PublicContextualVariantAvailabilityDto[];
  stockPresentation: PublicStockPresentationDto;
}

/**
 * F3.WU9 slice 7 — contextual public product body: the legacy product body
 * with compatibility `availability` mirroring `stockPresentation.status`
 * (null when hidden) and the product-level stock presentation. A distinct
 * shape — the legacy `PublicCatalogProductDetail` output is never widened.
 */
export interface PublicCatalogContextualProductBody
  extends Omit<PublicCatalogProductDetail, 'availability' | 'variants'> {
  availability: PublicStockStatus | null;
  stockPresentation: PublicStockPresentationDto;
  variants: PublicContextualVariantDto[];
}

/**
 * F2.WU6 slice 4b — context-explicit public product detail response.
 * Flatly extends the existing product body (canonical design: "Detail
 * extends the existing product body with") with exact public price-context
 * metadata and a literal `excludedCount: 0` — the mapping is
 * exact-selected-only and never rewrites prices, so nothing is excluded at
 * this layer. F3.WU9 slice 7 activates the stock presentation on this
 * contextual shape only.
 */
export interface PublicCatalogProductDetailWithContextDto
  extends PublicCatalogContextualProductBody {
  priceContext: PublicPriceContextDto;
  excludedCount: 0;
}

/**
 * F3.WU9 slice 9 — contextual public product card: the legacy card shape with
 * a compatibility `availability` mirroring `stockPresentation.status` (null
 * when hidden) and the product/card-level stock presentation. A distinct
 * shape — the legacy `PublicCatalogProductCard` output is never widened, and
 * no variant rows or operational quantities are embedded.
 */
export interface PublicCatalogContextualProductCard
  extends Omit<PublicCatalogProductCard, 'availability'> {
  availability: PublicStockStatus | null;
  stockPresentation: PublicStockPresentationDto;
}

/**
 * F2.WU6 slice 5a — context-explicit public product list response.
 * Extends the existing paginated list shape (canonical design: the list
 * response adds `excludedCount` and `priceContext` to the existing shape)
 * with context-eligible pagination metadata, aggregate `excludedCount`, and
 * exact public price-context metadata. F3.WU9 slice 9 activates the product/
 * card-level stock presentation on the contextual card items only.
 */
export interface PublicCatalogProductListWithContextDto {
  items: PublicCatalogContextualProductCard[];
  meta: {
    page: number;
    limit: number;
    /** Context-eligible, filter-matching aggregate total — before pagination. */
    total: number;
    totalPages: number;
  };
  facets: {
    categories: PublicCatalogCategoryFacet[];
  };
  /** Base published/filter-matching count minus eligible count. */
  excludedCount: number;
  priceContext: PublicPriceContextDto;
}
