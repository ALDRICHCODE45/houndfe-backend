import type { PublicBranchDto } from '../dto/public-branch.dto';
import type { PublicCatalogCategoryFacet } from '../dto/public-category-facet.dto';
import type {
  ProductWithIncludes,
  ProductDetailWithIncludes,
} from '../mappers/public-product.mapper';
import type { CatalogStockPresentationValue } from '../../../catalog-settings/domain/tenant-catalog-settings.aggregate';

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
  /**
   * F3.WU9 slice 5 — tenant stock-presentation defaults snapshot, resolved
   * by the same one-query context lookup and threaded unchanged. Internal
   * only: no mapper/controller/DTO consumption yet, no `SYSTEM_STATUS`
   * fallback, and no reinterpretation of Slice 4 participant snapshots.
   */
  stockPresentationDefaults: {
    catalogStockPresentationDefault: CatalogStockPresentationValue;
    catalogStockPresentationDefaultCustomQty: number | null;
  };
}

/**
 * F2.WU7 slice 1 — the repository projection later cart reconciliation
 * classifies. Excluded/SERVICE products and requested OFF variants are
 * deliberately retained: publication classification is an application
 * decision, never an adapter one. Price projections carry only exact
 * selected-context positive rows — empty arrays mean no price in context,
 * never a fallback.
 */
export interface PublicCartCandidate {
  id: string;
  name: string;
  type: string;
  includeInOnlineCatalog: boolean;
  hasVariants: boolean;
  useStock: boolean;
  quantity: number;
  minQuantity: number;
  hidePriceInOnlineCatalog: boolean;
  requiresPrescription: boolean;
  /** Main product image (isMain, variantId null), if any. */
  images: Array<{ url: string }>;
  /** Same-tenant allowlist rows; zero rows = every context is allowed. */
  catalogPriceLists: Array<{ globalPriceListId: string }>;
  /** Exact selected-context positive price; empty = no price in context. */
  priceLists: Array<{ priceCents: number }>;
  /** Requested variants only; requested OFF variants are retained. */
  variants: Array<{
    id: string;
    name: string;
    catalogPublishMode: string;
    quantity: number;
    minQuantity: number;
    variantPrices: Array<{ priceCents: number }>;
  }>;
}

/**
 * F3.WU9 slice 4 — one stock-presentation participant snapshot. Exactly
 * `quantity` and `minQuantity`: no IDs, tenant IDs, publish modes, custom
 * quantities, useStock, resolved, or other operational values beyond these
 * two fields.
 */
export interface PublicStockPresentationParticipant {
  quantity: number;
  minQuantity: number;
}

/**
 * F3.WU9 slice 4 — internal exact-context detail projection. Extends
 * `ProductDetailWithIncludes` with the required
 * `stockPresentationParticipants` collection (an independent snapshot from
 * every same-tenant non-OFF variant returned by the publication-gated
 * detail query, captured before the selected-price display filtering).
 * Scoped to `getPublicProductDetail` only so the legacy detail shape is
 * never widened. Non-variant products carry an empty collection.
 */
export interface PublicProductDetailProjection extends ProductDetailWithIncludes {
  stockPresentationParticipants: PublicStockPresentationParticipant[];
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
   *
   * F3.WU9 slice 4 — the return type is narrowed to the internal
   * `PublicProductDetailProjection`, which adds the required
   * `stockPresentationParticipants` collection on top of the unchanged
   * `ProductDetailWithIncludes` shape. Legacy `findProductById` and
   * unrelated fixtures are NOT widened; the collection stays internal
   * (no mapper/controller/use-case/DTO consumption).
   */
  getPublicProductDetail?(params: {
    tenantId: string;
    productId: string;
    context: ResolvedPublicCatalogContext;
  }): Promise<PublicProductDetailProjection | null>;

  /**
   * F2.WU7 — required bulk-load seam for stateless cart reconciliation:
   * one tenant-scoped `product.findMany` projecting the requested
   * products, their requested variants, same-tenant allowlist rows, and
   * exact selected-context positive price projections, with no
   * publication/stock/price decision applied here. Tenant/context mismatch
   * returns no candidates without a database call. Mandatory on the port:
   * cart reconciliation fails closed with a generic miss when a malformed
   * or absent implementation is injected.
   */
  findPublicCartCandidates(params: {
    tenantId: string;
    context: ResolvedPublicCatalogContext;
    productIds: string[];
    variantIds: string[];
  }): Promise<PublicCartCandidate[]>;
}

export const PUBLIC_CATALOG_REPOSITORY = Symbol('PUBLIC_CATALOG_REPOSITORY');
