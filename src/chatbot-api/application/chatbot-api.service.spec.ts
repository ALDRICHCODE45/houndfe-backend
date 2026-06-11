import { NotFoundException } from '@nestjs/common';
import type { IPublicCatalogRepository } from '../../public-catalog/application/ports/public-catalog.repository';
import type {
  ProductDetailWithIncludes,
  ProductWithIncludes,
} from '../../public-catalog/application/mappers/public-product.mapper';
import { ChatbotApiService } from './chatbot-api.service';

function makeCatalogProduct(
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin Mini Adult',
    description: 'Dry food for small dogs',
    hasVariants: true,
    useStock: true,
    quantity: 12,
    minQuantity: 3,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Food' },
    brand: { name: 'Royal Canin' },
    images: [{ url: 'https://cdn.example.com/main.jpg' }],
    priceLists: [{ priceCents: 259900 }],
    variants: [
      {
        id: 'var-1',
        name: '3 kg',
        option: 'Weight',
        value: '3kg',
        quantity: 2,
        minQuantity: 2,
        variantPrices: [{ priceCents: 249900 }],
      },
      {
        id: 'var-2',
        name: '8 kg',
        option: 'Weight',
        value: '8kg',
        quantity: 7,
        minQuantity: 2,
        variantPrices: [{ priceCents: 499900 }],
      },
    ],
    ...overrides,
  };
}

function makeDetailProduct(
  overrides: Partial<ProductDetailWithIncludes> = {},
): ProductDetailWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin Mini Adult',
    description: 'Dry food for small dogs',
    hasVariants: true,
    useStock: true,
    quantity: 0,
    minQuantity: 0,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Food' },
    brand: { name: 'Royal Canin' },
    images: [
      { id: 'img-1', url: 'https://cdn.example.com/main.jpg', isMain: true },
    ],
    priceLists: [{ priceCents: 259900 }],
    variants: [
      {
        id: 'var-1',
        name: '3 kg',
        option: 'Weight',
        value: '3kg',
        quantity: 0,
        minQuantity: 1,
        images: [{ url: 'https://cdn.example.com/var-1.jpg' }],
        variantPrices: [{ priceCents: 249900 }],
      },
    ],
    ...overrides,
  };
}

describe('ChatbotApiService', () => {
  let repository: jest.Mocked<IPublicCatalogRepository>;
  let service: ChatbotApiService;

  beforeEach(() => {
    repository = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn(),
      findCategoryFacets: jest.fn(),
      findProductById: jest.fn(),
    };
    service = new ChatbotApiService(repository);
  });

  it('returns safe catalog projections with promotion placeholder, stock summary, and package data', async () => {
    repository.findProducts.mockResolvedValue({
      items: [makeCatalogProduct()],
      total: 1,
    });

    const result = await service.searchCatalog({ q: 'royal', limit: 5 });

    expect(repository.findProducts.mock.calls).toEqual([
      [
        {
          q: 'royal',
          sort: 'relevance',
          page: 1,
          limit: 5,
        },
      ],
    ]);
    expect(result).toEqual([
      {
        productId: 'prod-1',
        name: 'Royal Canin Mini Adult',
        brand: 'Royal Canin',
        imageUrl: 'https://cdn.example.com/main.jpg',
        description: 'Dry food for small dogs',
        price: {
          priceCents: 259900,
          fromPriceCents: 249900,
          promoPriceCents: null,
          promotionEvaluationStatus: 'needs_human_review',
        },
        stock: {
          status: 'available',
          quantity: 12,
        },
        packageInfo: {
          weightGrams: null,
          dimensions: null,
        },
        variants: [
          {
            variantId: 'var-1',
            name: '3 kg',
            option: 'Weight',
            value: '3kg',
            priceCents: 249900,
            stock: { status: 'low_stock', quantity: 2 },
          },
          {
            variantId: 'var-2',
            name: '8 kg',
            option: 'Weight',
            value: '8kg',
            priceCents: 499900,
            stock: { status: 'available', quantity: 7 },
          },
        ],
      },
    ]);
    expect(result[0]).not.toHaveProperty('tenantId');
    expect(result[0]).not.toHaveProperty('purchaseNetCostCents');
    expect(result[0]).not.toHaveProperty('purchaseGrossCostCents');
  });

  it('returns an empty array when no catalog items match the search', async () => {
    repository.findProducts.mockResolvedValue({ items: [], total: 0 });

    await expect(
      service.searchCatalog({ q: 'missing', limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('returns out_of_stock with quantity 0 for zero-stock products', async () => {
    repository.findProductById.mockResolvedValue(
      makeDetailProduct({
        hasVariants: false,
        quantity: 0,
        minQuantity: 1,
        variants: [],
      }),
    );

    await expect(service.checkStock('prod-1')).resolves.toEqual({
      productId: 'prod-1',
      name: 'Royal Canin Mini Adult',
      stock: { status: 'out_of_stock', quantity: 0 },
      variants: [],
    });
  });

  it('returns not_managed stock when the product does not use stock tracking', async () => {
    repository.findProductById.mockResolvedValue(
      makeDetailProduct({
        useStock: false,
        quantity: 0,
        variants: [
          {
            id: 'var-1',
            name: '3 kg',
            option: 'Weight',
            value: '3kg',
            quantity: 0,
            minQuantity: 1,
            images: [],
            variantPrices: [{ priceCents: 249900 }],
          },
        ],
      }),
    );

    await expect(service.checkStock('prod-1')).resolves.toEqual({
      productId: 'prod-1',
      name: 'Royal Canin Mini Adult',
      stock: { status: 'not_managed', quantity: null },
      variants: [
        {
          variantId: 'var-1',
          name: '3 kg',
          option: 'Weight',
          value: '3kg',
          stock: { status: 'not_managed', quantity: null },
        },
      ],
    });
  });

  it('throws not found when the product does not exist in branch scope', async () => {
    repository.findProductById.mockResolvedValue(null);

    await expect(service.checkStock('missing-product')).rejects.toThrow(
      NotFoundException,
    );
  });
});
