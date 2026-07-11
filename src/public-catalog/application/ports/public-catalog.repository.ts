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

  findProductById(productId: string): Promise<ProductDetailWithIncludes | null>;
}

export const PUBLIC_CATALOG_REPOSITORY = Symbol('PUBLIC_CATALOG_REPOSITORY');
