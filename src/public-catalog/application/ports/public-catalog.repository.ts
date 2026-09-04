import type { PublicBranchDto } from '../dto/public-branch.dto';
import type { PublicCatalogCategoryFacet } from '../dto/public-category-facet.dto';
import type {
  ProductWithIncludes,
  ProductDetailWithIncludes,
} from '../mappers/public-product.mapper';

export interface ListProductsParams {
  q?: string;
  categoryId?: string;
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating_desc';
  page: number;
  limit: number;
  /**
   * F1.WU5b — resolved tenant catalog-default global price-list ID. Public
   * list/detail use cases always thread it after fail-closed resolution;
   * optional so legacy consumers remain source-compatible.
   */
  globalPriceListId?: string;
}

// F2.WU6 — the one public price context resolved per request.
export interface ResolvedPublicCatalogContext {
  tenantId: string;
  tenantSlug: string;
  globalPriceListId: string;
  name: string;
  isCatalogDefault: boolean;
}

export interface IPublicCatalogRepository {
  findActiveBranches(): Promise<PublicBranchDto[]>;

  findProducts(params: ListProductsParams): Promise<{
    items: ProductWithIncludes[];
    total: number;
  }>;

  findCategoryFacets(params: {
    q?: string;
  }): Promise<PublicCatalogCategoryFacet[]>;

  findProductById(
    productId: string,
    /**
     * F1.WU5b — resolved tenant catalog-default global price-list ID threaded
     * by the detail use case after fail-closed resolution.
     */
    globalPriceListId?: string,
  ): Promise<ProductDetailWithIncludes | null>;

  /**
   * F1.WU5b — resolves the current tenant's `isCatalogDefault=true` binding to
   * its global price-list ID, or null when the tenant has no catalog default
   * (callers must fail closed). Optional on the port because only public
   * list/detail use cases resolve the tenant price context; legacy consumers
   * predate it and fail closed when the implementation is absent.
   */
  findTenantCatalogDefaultPriceListId?(): Promise<string | null>;

  /**
   * F2.WU6 — one-query context resolution for `tenantSlug`: exact supplied
   * ID or the catalog default; null (never a fallback) on every miss.
   * Mandatory on the port: the F2 price context is a required repository
   * capability and callers must not silently tolerate its absence.
   */
  resolveTenantCatalogContext(
    tenantSlug: string,
    requestedGlobalPriceListId?: string,
  ): Promise<ResolvedPublicCatalogContext | null>;
}

export const PUBLIC_CATALOG_REPOSITORY = Symbol('PUBLIC_CATALOG_REPOSITORY');
