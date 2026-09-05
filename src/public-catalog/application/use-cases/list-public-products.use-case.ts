import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { toPublicProductCard } from '../mappers/public-product.mapper';
import type { PublicCatalogProductCard } from '../dto/public-product-card.dto';
import type { PublicCatalogCategoryFacet } from '../dto/public-category-facet.dto';
import type { ResolvedPublicCatalogContext } from '../ports/public-catalog.repository';
import type {
  PublicCatalogProductListWithContextDto,
  PublicPriceContextDto,
} from '../dto/public-price-context.dto';

export interface ListProductsInput {
  q?: string;
  categoryId?: string;
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating_desc';
  page: number;
  limit: number;
}

export interface ListProductsOutput {
  items: PublicCatalogProductCard[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  facets: {
    categories: PublicCatalogCategoryFacet[];
  };
}

/** F2.WU6 slice 5a — input for the dormant context-explicit list seam. */
export interface ListPublicProductsForContextInput {
  tenant: { id: string; slug: string; name: string };
  /** Already resolved by the upstream price-context resolver. */
  context: ResolvedPublicCatalogContext;
  filters: ListProductsInput;
}

@Injectable()
export class ListPublicProductsUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
  ) {}

  async execute(input: ListProductsInput): Promise<ListProductsOutput> {
    // F1.WU5b — fail closed: without a resolved tenant catalog-default
    // global price list, no product read happens and the existing empty
    // paginated shape is returned with the requested pagination values.
    const defaultPriceListId =
      (await this.repo.findTenantCatalogDefaultPriceListId?.()) ?? null;
    if (defaultPriceListId === null) {
      return {
        items: [],
        meta: {
          page: input.page,
          limit: input.limit,
          total: 0,
          totalPages: 0,
        },
        facets: { categories: [] },
      };
    }

    const [{ items, total }, categories] = await Promise.all([
      this.repo.findProducts({
        q: input.q,
        categoryId: input.categoryId,
        sort: input.sort,
        page: input.page,
        limit: input.limit,
        globalPriceListId: defaultPriceListId,
      }),
      this.repo.findCategoryFacets({ q: input.q }),
    ]);

    return {
      items: items.map((p) => toPublicProductCard(p)),
      meta: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit) || 0,
      },
      facets: { categories },
    };
  }

  /**
   * F2.WU6 slice 5a — dormant, uncalled context-explicit list seam. The price
   * context arrives already resolved upstream. Fails closed with the generic
   * `NotFoundException('Not Found')` on tenant ID or slug mismatch (before any
   * repository access) and on an absent optional seam — no optional-chain into
   * undefined, no legacy fallback, no retry, no context resolution. It never
   * touches the default-list path. `meta.total` and `totalPages` derive from
   * the eligible aggregate total and limit, never from `items.length`.
   */
  async executeForContext(
    input: ListPublicProductsForContextInput,
  ): Promise<PublicCatalogProductListWithContextDto> {
    const { tenant, context, filters } = input;

    // Fail closed before any repository access when the request tenant
    // does not match the resolved public price context.
    if (tenant.id !== context.tenantId || tenant.slug !== context.tenantSlug) {
      throw new NotFoundException('Not Found');
    }

    // Optional seam: absent implementation is a generic miss — never an
    // optional-chain into undefined and never a legacy fallback.
    if (!this.repo.listPublicProducts) {
      throw new NotFoundException('Not Found');
    }

    const { items, total, excludedCount, categories } =
      await this.repo.listPublicProducts({
        tenantId: tenant.id,
        context,
        filters: {
          q: filters.q,
          categoryId: filters.categoryId,
          sort: filters.sort,
          page: filters.page,
          limit: filters.limit,
        },
      });

    const priceContext: PublicPriceContextDto = {
      priceListId: context.globalPriceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    };

    return {
      items: items.map((p) => toPublicProductCard(p)),
      meta: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit) || 0,
      },
      facets: { categories },
      excludedCount,
      priceContext,
    };
  }
}
