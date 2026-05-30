import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ProductWithIncludes } from '../application/mappers/public-product.mapper';

function makeProduct(
  id: string,
  priceCents: number,
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento' },
    brand: { name: 'Brand' },
    images: [{ url: `https://cdn.example.com/${id}.jpg` }],
    priceLists: [{ priceCents }],
    variants: [],
    ...overrides,
  };
}

describe('PrismaPublicCatalogRepository (WARNING-01 regression)', () => {
  let repo: PrismaPublicCatalogRepository;
  let mockFindMany: jest.Mock;
  let mockCount: jest.Mock;

  beforeEach(() => {
    mockFindMany = jest.fn();
    mockCount = jest.fn();

    const mockTenantPrisma = {
      getClient: () => ({
        product: {
          findMany: mockFindMany,
          count: mockCount,
          groupBy: jest.fn().mockResolvedValue([]),
        },
      }),
    } as unknown as TenantPrismaService;

    const mockPrisma = {
      category: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    repo = new PrismaPublicCatalogRepository(mockPrisma, mockTenantPrisma);
  });

  it('should sort price_asc by actual priceCents (cheapest first)', async () => {
    // Products returned from DB in arbitrary order
    mockFindMany.mockResolvedValue([
      makeProduct('expensive', 200000),
      makeProduct('cheap', 50000),
      makeProduct('mid', 100000),
    ]);
    mockCount.mockResolvedValue(3);

    const { items } = await repo.findProducts({
      sort: 'price_asc',
      page: 1,
      limit: 20,
    });

    // Must be sorted by priceCents ascending: 50000, 100000, 200000
    expect(items[0].priceLists[0].priceCents).toBe(50000);
    expect(items[1].priceLists[0].priceCents).toBe(100000);
    expect(items[2].priceLists[0].priceCents).toBe(200000);
  });

  it('should sort price_desc by actual priceCents (most expensive first)', async () => {
    mockFindMany.mockResolvedValue([
      makeProduct('cheap', 50000),
      makeProduct('mid', 100000),
      makeProduct('expensive', 200000),
    ]);
    mockCount.mockResolvedValue(3);

    const { items } = await repo.findProducts({
      sort: 'price_desc',
      page: 1,
      limit: 20,
    });

    // Must be sorted by priceCents descending: 200000, 100000, 50000
    expect(items[0].priceLists[0].priceCents).toBe(200000);
    expect(items[1].priceLists[0].priceCents).toBe(100000);
    expect(items[2].priceLists[0].priceCents).toBe(50000);
  });

  it('should place products with no price list last in price_asc', async () => {
    mockFindMany.mockResolvedValue([
      makeProduct('no-price', 0, { priceLists: [] }),
      makeProduct('cheap', 50000),
    ]);
    mockCount.mockResolvedValue(2);

    const { items } = await repo.findProducts({
      sort: 'price_asc',
      page: 1,
      limit: 20,
    });

    // Products with price come first, no-price products last
    expect(items[0].priceLists[0]?.priceCents).toBe(50000);
    expect(items[1].priceLists).toHaveLength(0);
  });
});
