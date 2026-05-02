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
  return new ProductsService(repo, prisma, makeMockFilesService(), {
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
  } as any);
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
      });
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
});
