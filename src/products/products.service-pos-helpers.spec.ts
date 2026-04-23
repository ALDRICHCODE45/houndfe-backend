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
  return new ProductsService(repo, prisma, makeMockFilesService());
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
});
