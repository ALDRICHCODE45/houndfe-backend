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

  /**
   * F2.WU6 slice 3 — completed optional, unactivated exact-context
   * public listing contract: context-eligible items, `total` and
   * aggregate `excludedCount` computed before pagination, and
   * context-eligible category facets. No production caller yet;
   * activation (use-case/controller/DTO wiring) stays out of this
   * slice. Eligibility must be applied in the adapter's Prisma
   * `where` before pagination; no in-memory eligibility filtering
   * is permitted.
   */
  listPublicProducts?(params: {
    tenantId: string;
    context: ResolvedPublicCatalogContext;
    filters: ListProductsParams;
  }): Promise<{
    items: ProductWithIncludes[];
    /** Context-eligible, filter-matching count — before pagination. */
    total: number;
    /** Base published/filter-matching count minus eligible count. */
    excludedCount: number;
    categories: PublicCatalogCategoryFacet[];
  }>;

  /**
   * F2.WU6 slice 4a — optional, unactivated exact-context public detail
   * contract: the detail projection for one product under the selected
   * price context, or a generic null for every miss (tenant mismatch,
   * wrong tenant, unpublished, excluded, SERVICE, all-OFF, allowlist
   * mismatch, missing/zero selected price, failed variant BOTH). No
   * production caller; HTTP miss mapping stays in dormant Slice 4b.
   */
  getPublicProductDetail?(params: {
    tenantId: string;
    productId: string;
    context: ResolvedPublicCatalogContext;
  }): Promise<ProductDetailWithIncludes | null>;
}

export const PUBLIC_CATALOG_REPOSITORY = Symbol('PUBLIC_CATALOG_REPOSITORY');
