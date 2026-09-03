import { ListPublicProductsUseCase } from './list-public-products.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';
import type { ProductWithIncludes } from '../mappers/public-product.mapper';

function makeProduct(
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin 13.6kg',
    description: 'Dog food',
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento Seco' },
    brand: { name: 'Royal Canin' },
    images: [{ url: 'https://cdn.example.com/img1.jpg' }],
    priceLists: [{ priceCents: 125000 }],
    variants: [],
    ...overrides,
  };
}

describe('ListPublicProductsUseCase', () => {
  let mockFindProducts: jest.Mock;
  let mockFindCategoryFacets: jest.Mock;
  let mockResolveDefault: jest.Mock;
  let useCase: ListPublicProductsUseCase;

  beforeEach(() => {
    mockFindProducts = jest.fn().mockResolvedValue({ items: [], total: 0 });
    mockFindCategoryFacets = jest.fn().mockResolvedValue([]);
    mockResolveDefault = jest.fn().mockResolvedValue(null);
    const repo = {
      findActiveBranches: jest.fn(),
      findProducts: mockFindProducts,
      findCategoryFacets: mockFindCategoryFacets,
      findProductById: jest.fn().mockResolvedValue(null),
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    useCase = new ListPublicProductsUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  const baseInput = {
    q: 'canin',
    categoryId: 'cat-1',
    sort: 'relevance' as const,
    page: 2,
    limit: 10,
  };

  it('resolves the tenant catalog default exactly once and threads the exact global price-list ID into findProducts', async () => {
    mockResolveDefault.mockResolvedValue('gpl-default-1');
    mockFindProducts.mockResolvedValue({
      items: [makeProduct()],
      total: 1,
    });
    mockFindCategoryFacets.mockResolvedValue([
      { id: 'cat-1', name: 'Alimento Seco', productCount: 1 },
    ]);

    const result = await useCase.execute(baseInput);

    expect(mockResolveDefault).toHaveBeenCalledTimes(1);
    expect(mockFindProducts).toHaveBeenCalledTimes(1);
    expect(mockFindProducts).toHaveBeenCalledWith({
      q: 'canin',
      categoryId: 'cat-1',
      sort: 'relevance',
      page: 2,
      limit: 10,
      globalPriceListId: 'gpl-default-1',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'prod-1' });
    expect(result.meta).toEqual({
      page: 2,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
    expect(result.facets.categories).toEqual([
      { id: 'cat-1', name: 'Alimento Seco', productCount: 1 },
    ]);
  });

  it.each([
    ['explicit null', null],
    ['undefined resolver result', undefined],
  ])(
    'fails closed when the resolver returns %s: returns the exact existing empty paginated shape and performs no product read',
    async (_label, resolverResult) => {
      mockResolveDefault.mockResolvedValue(resolverResult);

      const result = await useCase.execute(baseInput);

      expect(mockResolveDefault).toHaveBeenCalledTimes(1);
      expect(mockFindProducts).not.toHaveBeenCalled();
      expect(result).toEqual({
        items: [],
        meta: { page: 2, limit: 10, total: 0, totalPages: 0 },
        facets: { categories: [] },
      });
    },
  );

  it('fails closed when the repository does not implement the optional resolver', async () => {
    const repo: Record<string, unknown> = {
      findActiveBranches: jest.fn(),
      findProducts: mockFindProducts,
      findCategoryFacets: mockFindCategoryFacets,
      findProductById: jest.fn().mockResolvedValue(null),
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    delete repo.findTenantCatalogDefaultPriceListId;
    const withoutResolver = new ListPublicProductsUseCase(
      repo as unknown as IPublicCatalogRepository,
    );

    const result = await withoutResolver.execute({
      q: undefined,
      categoryId: undefined,
      sort: 'newest',
      page: 1,
      limit: 20,
    });

    expect(mockFindProducts).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      facets: { categories: [] },
    });
  });
});
