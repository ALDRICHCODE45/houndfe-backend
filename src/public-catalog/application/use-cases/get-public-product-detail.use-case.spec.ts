import { NotFoundException } from '@nestjs/common';
import { GetPublicProductDetailUseCase } from './get-public-product-detail.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';
import type { ProductDetailWithIncludes } from '../mappers/public-product.mapper';

function makeDetail(
  overrides: Partial<ProductDetailWithIncludes> = {},
): ProductDetailWithIncludes {
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
    images: [
      { id: 'img-1', url: 'https://cdn.example.com/img1.jpg', isMain: true },
    ],
    priceLists: [{ priceCents: 125000 }],
    variants: [
      {
        id: 'var-1',
        name: '13.6kg',
        option: 'weight',
        value: '13.6',
        quantity: 10,
        minQuantity: 2,
        images: [{ url: 'https://cdn.example.com/img1.jpg' }],
        variantPrices: [{ priceCents: 125000 }],
      },
    ],
    ...overrides,
  };
}

const tenant = { id: 'tenant-1', slug: 'petshop', name: 'Petshop' };

describe('GetPublicProductDetailUseCase', () => {
  let mockFindProductById: jest.Mock;
  let mockResolveDefault: jest.Mock;
  let useCase: GetPublicProductDetailUseCase;

  beforeEach(() => {
    mockFindProductById = jest.fn().mockResolvedValue(null);
    mockResolveDefault = jest.fn().mockResolvedValue(null);
    const repo = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findCategoryFacets: jest.fn().mockResolvedValue([]),
      findProductById: mockFindProductById,
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    useCase = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('resolves the tenant catalog default exactly once and threads the exact global price-list ID into findProductById', async () => {
    mockResolveDefault.mockResolvedValue('gpl-default-1');
    mockFindProductById.mockResolvedValue(makeDetail());

    const result = await useCase.execute('prod-1', tenant);

    expect(mockResolveDefault).toHaveBeenCalledTimes(1);
    expect(mockFindProductById).toHaveBeenCalledTimes(1);
    expect(mockFindProductById).toHaveBeenCalledWith('prod-1', 'gpl-default-1');
    expect(result).toMatchObject({
      id: 'prod-1',
      name: 'Royal Canin 13.6kg',
      price: { priceCents: 125000, hidden: false },
      variants: [
        expect.objectContaining({
          id: 'var-1',
          price: { priceCents: 125000, hidden: false },
        }),
      ],
    });
  });

  it.each([
    ['explicit null', null],
    ['undefined resolver result', undefined],
  ])(
    'fails closed when the resolver returns %s: throws NotFoundException without performing the product read',
    async (_label, resolverResult) => {
      mockResolveDefault.mockResolvedValue(resolverResult);

      await expect(useCase.execute('prod-1', tenant)).rejects.toThrow(
        new NotFoundException('Not Found'),
      );
      expect(mockResolveDefault).toHaveBeenCalledTimes(1);
      expect(mockFindProductById).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the repository does not implement the optional resolver', async () => {
    const repo: Record<string, unknown> = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      findCategoryFacets: jest.fn().mockResolvedValue([]),
      findProductById: mockFindProductById,
      findTenantCatalogDefaultPriceListId: mockResolveDefault,
    };
    delete repo.findTenantCatalogDefaultPriceListId;
    const withoutResolver = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );

    await expect(withoutResolver.execute('prod-1', tenant)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(mockFindProductById).not.toHaveBeenCalled();
  });

  it('keeps the existing not-found behavior when the product is missing despite a resolved default', async () => {
    mockResolveDefault.mockResolvedValue('gpl-default-1');

    await expect(useCase.execute('missing-1', tenant)).rejects.toThrow(
      new NotFoundException('Not Found'),
    );
    expect(mockFindProductById).toHaveBeenCalledWith(
      'missing-1',
      'gpl-default-1',
    );
  });
});
