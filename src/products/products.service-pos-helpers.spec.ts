/**
 * ProductsService — POS Helper Methods Tests
 *
 * Tests for POS-specific helpers: product/variant validation, price fetching,
 * and stock availability checks.
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import { Product } from './domain/product.entity';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockRepo(overrides: Partial<IProductRepository> = {}) {
  return {
    findById: jest.fn(),
    findBySku: jest.fn(),
    findByBarcode: jest.fn(),
    findAll: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    isSkuTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    isBarcodeTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<IProductRepository>;
}

function makeMockPrisma(overrides: any = {}) {
  return {
    product: {
      findUnique: jest.fn(),
    },
    variant: {
      findFirst: jest.fn(),
    },
    priceList: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    variantPrice: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    productImage: {
      findFirst: jest.fn(),
    },
    ...overrides,
  };
}

function makeMockFilesService() {
  return {
    uploadAndRegister: jest.fn(),
    delete: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn(),
  } as any;
}

function createService(
  repo: IProductRepository,
  prisma: ReturnType<typeof makeMockPrisma>,
) {
  return new ProductsService(
    repo,
    prisma,
    makeMockFilesService(),
    {
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      getClient: jest.fn().mockReturnValue(prisma),
    } as any,
    {
      assertExists: jest.fn().mockResolvedValue(undefined),
      search: jest.fn(),
      findByKey: jest.fn(),
    } as any,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProductsService — POS Helpers', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: ProductsService;

  beforeEach(() => {
    repo = makeMockRepo();
    prisma = makeMockPrisma();
    service = createService(repo, prisma);
  });

  describe('getProductInfoForSale', () => {
    it('should use tenant prisma client for product info lookup', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'prod-tenant',
        name: 'Aspirina',
        hasVariants: false,
        sellInPos: true,
        useStock: false,
      });
      prisma.priceList.findFirst.mockResolvedValue({ priceCents: 1000 });

      const tenantPrisma = {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        getClient: jest.fn().mockReturnValue(prisma),
      };
      const serviceWithTenantSpy = new ProductsService(
        repo,
        prisma,
        makeMockFilesService(),
        tenantPrisma as any,
        {
          assertExists: jest.fn().mockResolvedValue(undefined),
          search: jest.fn(),
          findByKey: jest.fn(),
        } as any,
      );

      await serviceWithTenantSpy.getProductInfoForSale('prod-tenant', null);

      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });

    it('should return price and name for a product without variant', async () => {
      // Setup: product without variants
      const mockProduct = {
        id: 'prod-1',
        name: 'Aspirina',
        hasVariants: false,
        sellInPos: true,
        useStock: false,
      };

      const mockPriceList = {
        priceCents: 5000,
        globalPriceList: { isDefault: true },
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);
      prisma.priceList.findFirst.mockResolvedValue(mockPriceList);

      // Execute
      const result = await service.getProductInfoForSale('prod-1', null);

      // Assert
      expect(result).toEqual({
        productId: 'prod-1',
        productName: 'Aspirina',
        variantId: null,
        variantName: null,
        unitPriceCents: 5000,
        imageUrl: null,
      });
    });

    it('should return price and name for a product with variant', async () => {
      // Setup: product with variants
      const mockProduct = {
        id: 'prod-2',
        name: 'Camisa',
        hasVariants: true,
        sellInPos: true,
        useStock: false,
      };

      const mockVariant = {
        id: 'var-1',
        productId: 'prod-2',
        name: 'Roja M',
      };

      const mockVariantPrice = {
        priceCents: 15000,
        priceList: { globalPriceList: { isDefault: true } },
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);
      prisma.variant.findFirst.mockResolvedValue(mockVariant);
      prisma.priceList.findFirst.mockResolvedValue(null);

      // Mock variant price query
      prisma.variantPrice = {
        findFirst: jest.fn().mockResolvedValue(mockVariantPrice),
      };

      // Execute
      const result = await service.getProductInfoForSale('prod-2', 'var-1');

      // Assert
      expect(result).toEqual({
        productId: 'prod-2',
        productName: 'Camisa',
        variantId: 'var-1',
        variantName: 'Roja M',
        unitPriceCents: 15000,
        imageUrl: null,
      });
    });

    it('should resolve product main image with isMain desc and sortOrder asc', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'prod-image',
        name: 'Taza',
        hasVariants: false,
        sellInPos: true,
      });
      prisma.priceList.findFirst.mockResolvedValue({ priceCents: 2100 });

      prisma.productImage.findFirst.mockResolvedValue({
        url: 'https://cdn.example.com/main.jpg',
      });

      const result = await service.getProductInfoForSale('prod-image', null);

      expect(prisma.productImage.findFirst).toHaveBeenCalledWith({
        where: { productId: 'prod-image', variantId: null },
        orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
        select: { url: true },
      });
      expect(result.imageUrl).toBe('https://cdn.example.com/main.jpg');
    });

    it('should resolve variant main image with null fallback', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'prod-var-image',
        name: 'Camisa',
        hasVariants: true,
        sellInPos: true,
      });
      prisma.variant.findFirst.mockResolvedValue({
        id: 'var-blue',
        productId: 'prod-var-image',
        name: 'Azul',
      });
      prisma.variantPrice = {
        findFirst: jest.fn().mockResolvedValue({ priceCents: 999 }),
      };
      prisma.productImage.findFirst.mockResolvedValue(null);

      const result = await service.getProductInfoForSale(
        'prod-var-image',
        'var-blue',
      );

      expect(prisma.productImage.findFirst).toHaveBeenCalledWith({
        where: { productId: 'prod-var-image', variantId: 'var-blue' },
        orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
        select: { url: true },
      });
      expect(result.imageUrl).toBeNull();
    });

    it('should reject when product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.getProductInfoForSale('nonexistent', null),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when product has variants but variantId is null', async () => {
      const mockProduct = {
        id: 'prod-3',
        name: 'Zapatos',
        hasVariants: true,
        sellInPos: true,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      await expect(
        service.getProductInfoForSale('prod-3', null),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.getProductInfoForSale('prod-3', null),
      ).rejects.toThrow(/must specify a variant/);
    });

    it('should reject when product does not have variants but variantId is provided', async () => {
      const mockProduct = {
        id: 'prod-4',
        name: 'Arroz',
        hasVariants: false,
        sellInPos: true,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      await expect(
        service.getProductInfoForSale('prod-4', 'var-1'),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.getProductInfoForSale('prod-4', 'var-1'),
      ).rejects.toThrow(/does not have variants/);
    });

    it('should reject when variant does not exist', async () => {
      const mockProduct = {
        id: 'prod-5',
        name: 'Playera',
        hasVariants: true,
        sellInPos: true,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);
      prisma.variant.findFirst.mockResolvedValue(null);

      await expect(
        service.getProductInfoForSale('prod-5', 'nonexistent-var'),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should reject when product is not enabled for POS', async () => {
      const mockProduct = {
        id: 'prod-6',
        name: 'Item Interno',
        hasVariants: false,
        sellInPos: false,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      await expect(
        service.getProductInfoForSale('prod-6', null),
      ).rejects.toThrow(BusinessRuleViolationError);
      await expect(
        service.getProductInfoForSale('prod-6', null),
      ).rejects.toThrow(/not enabled for POS/);
    });
  });

  describe('checkStockAvailability', () => {
    it('should return available=true when product does not use stock', async () => {
      const mockProduct = {
        id: 'prod-7',
        useStock: false,
        hasVariants: false,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      const result = await service.checkStockAvailability('prod-7', null, 10);

      expect(result).toEqual({
        available: true,
        currentStock: null,
      });
    });

    it('should return available=true when sufficient stock exists (no variants)', async () => {
      const mockProduct = {
        id: 'prod-8',
        useStock: true,
        hasVariants: false,
        quantity: 50,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      const result = await service.checkStockAvailability('prod-8', null, 10);

      expect(result).toEqual({
        available: true,
        currentStock: 50,
      });
    });

    it('should return available=false when insufficient stock (no variants)', async () => {
      const mockProduct = {
        id: 'prod-9',
        useStock: true,
        hasVariants: false,
        quantity: 5,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);

      const result = await service.checkStockAvailability('prod-9', null, 10);

      expect(result).toEqual({
        available: false,
        currentStock: 5,
      });
    });

    it('should return available=true when sufficient variant stock exists', async () => {
      const mockProduct = {
        id: 'prod-10',
        useStock: true,
        hasVariants: true,
      };

      const mockVariant = {
        id: 'var-10',
        quantity: 30,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);
      prisma.variant.findFirst.mockResolvedValue(mockVariant);

      const result = await service.checkStockAvailability(
        'prod-10',
        'var-10',
        20,
      );

      expect(result).toEqual({
        available: true,
        currentStock: 30,
      });
    });

    it('should return available=false when insufficient variant stock', async () => {
      const mockProduct = {
        id: 'prod-11',
        useStock: true,
        hasVariants: true,
      };

      const mockVariant = {
        id: 'var-11',
        quantity: 5,
      };

      prisma.product.findUnique.mockResolvedValue(mockProduct);
      prisma.variant.findFirst.mockResolvedValue(mockVariant);

      const result = await service.checkStockAvailability(
        'prod-11',
        'var-11',
        10,
      );

      expect(result).toEqual({
        available: false,
        currentStock: 5,
      });
    });

    it('should reject when product does not exist', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.checkStockAvailability('nonexistent', null, 10),
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe('price override helpers', () => {
    it('getApplicablePrices should apply tier threshold and base fallback', async () => {
      prisma.priceList.findMany = jest.fn().mockResolvedValue([
        {
          id: 'pl-1',
          priceCents: 1000,
          tierPrices: [
            { minQuantity: 3, priceCents: 900 },
            { minQuantity: 10, priceCents: 800 },
          ],
          globalPriceList: { name: 'PUBLICO' },
        },
      ]);

      const q2 = await service.getApplicablePrices('prod-1', null, 2);
      const q3 = await service.getApplicablePrices('prod-1', null, 3);

      expect(q2[0].priceCents).toBe(1000);
      expect(q3[0].priceCents).toBe(900);
    });

    it('getApplicablePrices should filter by variant when variantId is provided', async () => {
      prisma.variantPrice = {
        findMany: jest.fn().mockResolvedValue([
          {
            priceListId: 'pl-1',
            priceCents: 1200,
            tierPrices: [{ minQuantity: 5, priceCents: 1100 }],
            priceList: { globalPriceList: { name: 'MAYOREO' } },
          },
        ]),
      };

      const prices = await service.getApplicablePrices('prod-2', 'var-2', 6);
      expect(prices).toHaveLength(1);
      expect(prices[0]).toMatchObject({
        priceListId: 'pl-1',
        priceListName: 'MAYOREO',
        priceCents: 1100,
      });
    });

    it('resolveListPrice should reject missing list', async () => {
      prisma.priceList.findMany = jest.fn().mockResolvedValue([]);

      await expect(
        service.resolveListPrice('missing', 'prod-3', null, 1),
      ).rejects.toThrow(/INVALID_PRICE_LIST_FOR_ITEM/);
    });
  });

  // WU1 — batchResolvePriceMap (POS Price List Tiers). Tier-aware
  // re-resolver that batches all line lookups in exactly TWO Prisma
  // queries (variant IN + product IN) regardless of line count.
  describe('batchResolvePriceMap — tier-aware batch resolver (WU1, spec Tier-Aware Price Resolution)', () => {
    type BatchInput = Parameters<
      ReturnType<typeof createService>['batchResolvePriceMap']
    >[0][number];
    type MapType = Awaited<
      ReturnType<ReturnType<typeof createService>['batchResolvePriceMap']>
    >;

    it('issues exactly two Prisma queries (1 variantPrice + 1 priceList) for N lines', async () => {
      const variantQuery = jest.fn().mockResolvedValue([]);
      const productQuery = jest.fn().mockResolvedValue([]);
      prisma.variantPrice.findMany = variantQuery;
      prisma.priceList.findMany = productQuery;

      const inputs: BatchInput[] = [
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 3,
        },
        {
          productId: 'p2',
          variantId: 'v2',
          priceListId: 'list-a',
          quantity: 5,
        },
        {
          productId: 'p1',
          variantId: null,
          priceListId: '__default__',
          quantity: 1,
        },
        {
          productId: 'p3',
          variantId: 'v3',
          priceListId: 'list-b',
          quantity: 10,
        },
      ];
      await service.batchResolvePriceMap(inputs);

      expect(variantQuery).toHaveBeenCalledTimes(1);
      expect(productQuery).toHaveBeenCalledTimes(1);
    });

    it('returns empty map and zero queries on empty input', async () => {
      const variantQuery = jest.fn();
      const productQuery = jest.fn();
      prisma.variantPrice.findMany = variantQuery;
      prisma.priceList.findMany = productQuery;

      const result = await service.batchResolvePriceMap([]);

      expect(result.size).toBe(0);
      expect(variantQuery).not.toHaveBeenCalled();
      expect(productQuery).not.toHaveBeenCalled();
    });

    it('selects highest applicable tier per line (highest minQuantity <= quantity wins)', async () => {
      // Two lines, same product, same variant, same list, two different
      // quantities → two different tier prices. The map MUST contain both
      // entries, each keyed on its (productId, variantId, priceListId)
      // tuple and selecting the highest minQuantity ≤ quantity.
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([
        {
          variantId: 'v1',
          priceListId: 'list-a',
          priceCents: 5000,
          tierPrices: [
            { minQuantity: 1, priceCents: 1000 },
            { minQuantity: 5, priceCents: 800 },
            { minQuantity: 10, priceCents: 600 },
          ],
        },
      ]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([]);

      const inputs: BatchInput[] = [
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 3,
        },
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 7,
        },
      ];
      const result = await service.batchResolvePriceMap(inputs);

      expect(result.get('p1::v1::list-a')?.get(3)).toBe(1000);
      expect(result.get('p1::v1::list-a')?.get(7)).toBe(800);
    });

    it('falls back to base priceCents below the lowest tier', async () => {
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([
        {
          variantId: 'v1',
          priceListId: 'list-a',
          priceCents: 1000, // base
          tierPrices: [{ minQuantity: 5, priceCents: 800 }],
        },
      ]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.batchResolvePriceMap([
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 3,
        },
      ]);

      expect(result.get('p1::v1::list-a')?.get(3)).toBe(1000);
    });

    it('ignores zero-price tier rows (treats as missing)', async () => {
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([
        {
          variantId: 'v1',
          priceListId: 'list-a',
          priceCents: 1000,
          tierPrices: [
            { minQuantity: 1, priceCents: 900 },
            { minQuantity: 5, priceCents: 0 }, // zero-price → ignored
          ],
        },
      ]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.batchResolvePriceMap([
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 6,
        },
      ]);

      // No positive-price tier matches qty=6 (the 5-tier is 0c and
      // ignored), so the resolver falls back to the 1-tier (900c).
      expect(result.get('p1::v1::list-a')?.get(6)).toBe(900);
    });

    it('uses only VariantTierPrice rows for variant lines (variant tiers beat product tiers)', async () => {
      // variant-tier price 800c; product-tier 600c should NOT apply to
      // the variant line. Resolver picks the variant tier only.
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([
        {
          variantId: 'v1',
          priceListId: 'list-a',
          priceCents: 1000,
          tierPrices: [{ minQuantity: 1, priceCents: 800 }],
        },
      ]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([
        // Product-level price row for the same (productId, list-a) —
        // should be ignored entirely for this variantId-bearing input.
        {
          productId: 'p1',
          globalPriceListId: 'gpl-a',
          priceCents: 1000,
          tierPrices: [{ minQuantity: 1, priceCents: 600 }],
        },
      ]);

      const result = await service.batchResolvePriceMap([
        {
          productId: 'p1',
          variantId: 'v1',
          priceListId: 'list-a',
          quantity: 1,
        },
      ]);

      expect(result.get('p1::v1::list-a')?.get(1)).toBe(800);
    });

    it('uses TierPrice (product-level) when variantId is null', async () => {
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([
        {
          id: 'list-a',
          productId: 'p1',
          priceCents: 1000,
          tierPrices: [{ minQuantity: 1, priceCents: 800 }],
        },
      ]);

      const result = await service.batchResolvePriceMap([
        {
          productId: 'p1',
          variantId: null,
          priceListId: 'list-a',
          quantity: 1,
        },
      ]);

      expect(result.get('p1::::list-a')?.get(1)).toBe(800);
    });

    it('returns no entry for inputs the resolver could not match (missing list → default fallback in caller)', async () => {
      // No list row returned for this (productId, list-a) tuple — the
      // resolver returns NO key in the map, leaving the caller free to
      // apply its default-list fallback contract (spec: "missing list
      // price falls back to default list").
      prisma.variantPrice.findMany = jest.fn().mockResolvedValue([]);
      prisma.priceList.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.batchResolvePriceMap([
        {
          productId: 'p1',
          variantId: null,
          priceListId: 'list-a',
          quantity: 1,
        },
      ]);

      expect(result.get('p1::::list-a')).toBeUndefined();
    });
  });
});
