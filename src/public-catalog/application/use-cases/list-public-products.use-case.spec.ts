import { NotFoundException } from '@nestjs/common';
import { ListPublicProductsUseCase } from './list-public-products.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';
import type { ResolvedPublicCatalogContext } from '../ports/public-catalog.repository';
import type { ProductWithIncludes } from '../mappers/public-product.mapper';
import type {
  PublicCatalogProductListWithContextDto,
  PublicPriceContextDto,
} from '../dto/public-price-context.dto';

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

describe('ListPublicProductsUseCase.executeForContext (F2.WU6 slice 5a — dormant seam)', () => {
  const context: ResolvedPublicCatalogContext = {
    tenantId: 'tenant-1',
    tenantSlug: 'petshop',
    globalPriceListId: 'gpl-sel-1',
    name: 'Spring Catalog',
    isCatalogDefault: false,
    stockPresentationDefaults: {
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
    },
  };

  const tenant = { id: 'tenant-1', slug: 'petshop', name: 'Petshop' };

  const listInput = {
    tenant,
    context,
    filters: {
      q: 'canin',
      categoryId: 'cat-1',
      sort: 'relevance' as const,
      page: 2,
      limit: 10,
    },
  };

  /** Same legacy inputs as the outer describe's `baseInput`, re-declared locally. */
  const legacyInput = { ...listInput.filters };

  let seam: jest.Mock;
  let legacyFindProducts: jest.Mock;
  let legacyFindCategoryFacets: jest.Mock;
  let resolveDefault: jest.Mock;
  let resolveContext: jest.Mock;
  let useCase: ListPublicProductsUseCase;

  const makeUseCase = (withSeam = true) => {
    seam = jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      excludedCount: 0,
      categories: [],
    });
    // Legacy booby traps: valid default-list data the contextual method must never reach.
    legacyFindProducts = jest
      .fn()
      .mockResolvedValue({ items: [makeProduct()], total: 1 });
    legacyFindCategoryFacets = jest
      .fn()
      .mockResolvedValue([
        { id: 'cat-9', name: 'Legacy Facet', productCount: 1 },
      ]);
    resolveDefault = jest.fn().mockResolvedValue('gpl-default-1');
    resolveContext = jest.fn().mockResolvedValue(null);
    const repo: Record<string, unknown> = {
      findActiveBranches: jest.fn(),
      findProducts: legacyFindProducts,
      findCategoryFacets: legacyFindCategoryFacets,
      findProductById: jest.fn().mockResolvedValue(null),
      findTenantCatalogDefaultPriceListId: resolveDefault,
      resolveTenantCatalogContext: resolveContext,
      listPublicProducts: seam,
    };
    if (!withSeam) delete repo.listPublicProducts;
    return new ListPublicProductsUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  };

  beforeEach(() => {
    useCase = makeUseCase();
  });

  it('maps the exact repository projection once with the exact seam args and appends the full eligible contextual shape', async () => {
    seam.mockResolvedValue({
      items: [makeProduct()],
      total: 25,
      excludedCount: 4,
      categories: [{ id: 'cat-1', name: 'Alimento Seco', productCount: 21 }],
    });

    const result = await useCase.executeForContext(listInput);

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      context,
      filters: {
        q: 'canin',
        categoryId: 'cat-1',
        sort: 'relevance',
        page: 2,
        limit: 10,
      },
    });
    expect(Object.keys(result)).toEqual([
      'items',
      'meta',
      'facets',
      'excludedCount',
      'priceContext',
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'prod-1',
      price: { fromPriceCents: 125000, priceCents: 125000, hidden: false },
    });
    expect(result.meta).toEqual({
      page: 2,
      limit: 10,
      total: 25,
      totalPages: 3,
    });
    expect(result.facets.categories).toEqual([
      { id: 'cat-1', name: 'Alimento Seco', productCount: 21 },
    ]);
    expect(result.excludedCount).toBe(4);
    expect(result.priceContext).toEqual({
      priceListId: 'gpl-sel-1',
      name: 'Spring Catalog',
      isCatalogDefault: false,
    });
    expect(legacyFindProducts).not.toHaveBeenCalled();
    expect(legacyFindCategoryFacets).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it('derives totalPages from the eligible aggregate total and limit, never from the page item length', async () => {
    seam.mockResolvedValue({
      items: [
        makeProduct({ id: 'p1' }),
        makeProduct({ id: 'p2' }),
        makeProduct({ id: 'p3' }),
      ],
      total: 23,
      excludedCount: 7,
      categories: [],
    });

    const result = await useCase.executeForContext(listInput);

    expect(result.meta.total).toBe(23);
    expect(result.meta.totalPages).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it.each([
    [
      'tenant ID mismatch',
      { id: 'tenant-2', slug: 'petshop', name: 'Petshop' },
    ],
    [
      'tenant slug mismatch',
      { id: 'tenant-1', slug: 'other', name: 'Petshop' },
    ],
  ])(
    'fails closed before any repository access on %s',
    async (_label, mismatchedTenant) => {
      await expect(
        useCase.executeForContext({
          ...listInput,
          tenant: mismatchedTenant,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(seam).not.toHaveBeenCalled();
      expect(legacyFindProducts).not.toHaveBeenCalled();
      expect(legacyFindCategoryFacets).not.toHaveBeenCalled();
    },
  );

  it('throws the generic NotFoundException when the optional seam is absent — no optional-chain into undefined and no fallback', async () => {
    const withoutSeam = makeUseCase(false);

    await expect(withoutSeam.executeForContext(listInput)).rejects.toThrow(
      NotFoundException,
    );
    expect(legacyFindProducts).not.toHaveBeenCalled();
    expect(legacyFindCategoryFacets).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('returns the contextual empty shape when the seam resolves zero eligible items and never falls back to the legacy list path', async () => {
    seam.mockResolvedValue({
      items: [],
      total: 0,
      excludedCount: 9,
      categories: [],
    });

    const result = await useCase.executeForContext(listInput);

    expect(seam).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      items: [],
      meta: { page: 2, limit: 10, total: 0, totalPages: 0 },
      facets: { categories: [] },
      excludedCount: 9,
      priceContext: {
        priceListId: 'gpl-sel-1',
        name: 'Spring Catalog',
        isCatalogDefault: false,
      },
    });
    expect(legacyFindProducts).not.toHaveBeenCalled();
    expect(legacyFindCategoryFacets).not.toHaveBeenCalled();
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['explicit non-default context', false],
    ['explicit catalog-default context', true],
  ])(
    'emits exact public metadata for the %s and never leaks tenant or list internals',
    async (_label, isCatalogDefault) => {
      seam.mockResolvedValue({
        items: [],
        total: 0,
        excludedCount: 0,
        categories: [],
      });

      const result = await useCase.executeForContext({
        ...listInput,
        context: { ...context, isCatalogDefault },
      });

      expect(Object.keys(result.priceContext)).toEqual([
        'priceListId',
        'name',
        'isCatalogDefault',
      ]);
      expect(result.priceContext).toEqual({
        priceListId: 'gpl-sel-1',
        name: 'Spring Catalog',
        isCatalogDefault,
      });
      const serialized = JSON.stringify(result.priceContext);
      expect(serialized).not.toContain('tenant-1');
      expect(serialized).not.toContain('petshop');
      expect(serialized).not.toContain('"globalPriceListId"');
    },
  );

  it('keeps the active execute path on the default-list resolver + findProducts/findCategoryFacets even when the contextual seam exists', async () => {
    const result = await useCase.execute(legacyInput);

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(legacyFindProducts).toHaveBeenCalledTimes(1);
    expect(legacyFindCategoryFacets).toHaveBeenCalledTimes(1);
    expect(seam).not.toHaveBeenCalled();
    expect(resolveContext).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('priceContext');
    expect(result).not.toHaveProperty('excludedCount');
  });
});

/**
 * Compile-time contract probe (type-level only): the seam must return the
 * canonical flat list contract; a nested envelope must not typecheck.
 */
type ReturnedForContext = Awaited<
  ReturnType<ListPublicProductsUseCase['executeForContext']>
>;
const _flat: ReturnedForContext extends PublicCatalogProductListWithContextDto
  ? true
  : false = true;
void _flat;
const _nested: PublicCatalogProductListWithContextDto = {
  // @ts-expect-error — the response must be flat, never an enveloped wrapper
  list: null as unknown as PublicCatalogProductListWithContextDto,
  meta: null as unknown as PublicCatalogProductListWithContextDto['meta'],
  facets: null as unknown as PublicCatalogProductListWithContextDto['facets'],
  excludedCount: 0,
  priceContext: null as unknown as PublicPriceContextDto,
};
void _nested;
