import { Inject, Injectable } from '@nestjs/common';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { toPublicProductCard } from '../mappers/public-product.mapper';
import type { PublicCatalogProductCard } from '../dto/public-product-card.dto';
import type { PublicCatalogCategoryFacet } from '../dto/public-category-facet.dto';

export interface ListProductsInput {
  q?: string;
  categoryId?: string;
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'newest';
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

@Injectable()
export class ListPublicProductsUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
  ) {}

  async execute(input: ListProductsInput): Promise<ListProductsOutput> {
    const [{ items, total }, categories] = await Promise.all([
      this.repo.findProducts({
        q: input.q,
        categoryId: input.categoryId,
        sort: input.sort,
        page: input.page,
        limit: input.limit,
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
}
