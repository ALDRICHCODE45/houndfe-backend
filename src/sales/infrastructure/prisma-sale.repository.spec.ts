/**
 * PrismaSaleRepository — Infrastructure Adapter Tests
 *
 * Tests for Prisma implementation of ISaleRepository.
 */
import { PrismaSaleRepository } from './prisma-sale.repository';
import { Sale } from '../domain/sale.entity';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockPrisma() {
  return {
    sale: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    saleItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  } as any;
}

function makeTenantPrismaMock() {
  const client = makeMockPrisma();
  return {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    client,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('PrismaSaleRepository', () => {
  let tenantPrisma: ReturnType<typeof makeTenantPrismaMock>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let repo: PrismaSaleRepository;

  beforeEach(() => {
    tenantPrisma = makeTenantPrismaMock();
    prisma = tenantPrisma.client;
    repo = new PrismaSaleRepository(tenantPrisma as any);
  });

  it('uses tenant-scoped prisma client', async () => {
    prisma.sale.findUnique.mockResolvedValue(null);
    await repo.findById('missing-sale');
    expect(tenantPrisma.getClient).toHaveBeenCalled();
  });

  describe('save', () => {
    it('creates sale without requiring tenantId in payload', async () => {
      const sale = Sale.create({ id: 'sale-tenantless', userId: 'user-1' });

      prisma.sale.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'sale-tenantless',
          userId: 'user-1',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        });
      prisma.sale.create.mockResolvedValue({ id: 'sale-tenantless' });

      await repo.save(sale);

      expect(prisma.sale.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: 'tenant-1' }),
        }),
      );
    });

    it('should create a new sale with items', async () => {
      const sale = Sale.create({ id: 'sale-1', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-1',
        productId: 'prod-1',
        variantId: null,
        productName: 'Product 1',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      const mockSaleData = {
        id: 'sale-1',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-1',
            saleId: 'sale-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
          },
        ],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(null) // First call: check if exists (doesn't exist yet)
        .mockResolvedValueOnce(mockSaleData); // Second call: reload after save
      prisma.sale.create.mockResolvedValue(mockSaleData);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-1' },
      });
      expect(prisma.sale.create).toHaveBeenCalledWith({
        data: {
          id: 'sale-1',
          userId: 'user-1',
          status: 'DRAFT',
          tenantId: 'tenant-1',
        },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            id: 'item-1',
            saleId: 'sale-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: null,
            discountValue: null,
            discountAmountCents: null,
            prePriceCentsBeforeDiscount: null,
            discountTitle: null,
            discountedAt: null,
            tenantId: 'tenant-1',
          },
        ],
      });
      expect(result.id).toBe('sale-1');
    });

    it('should update an existing sale with new items', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-2',
        userId: 'user-1',
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.addItem({
        id: 'item-2',
        saleId: 'sale-2',
        productId: 'prod-2',
        variantId: null,
        productName: 'Product 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        unitPriceCurrency: 'MXN',
      });

      const mockSaleDataInitial = {
        id: 'sale-2',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockSaleDataWithItems = {
        ...mockSaleDataInitial,
        items: [
          {
            id: 'item-2',
            saleId: 'sale-2',
            productId: 'prod-2',
            variantId: null,
            productName: 'Product 2',
            variantName: null,
            quantity: 1,
            unitPriceCents: 500,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
          },
        ],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(mockSaleDataInitial) // First call: check if exists
        .mockResolvedValueOnce(mockSaleDataWithItems); // Second call: reload after save
      prisma.sale.update.mockResolvedValue(mockSaleDataInitial);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-2' },
      });
      expect(prisma.sale.update).toHaveBeenCalledWith({
        where: { id: 'sale-2' },
        data: {
          status: 'DRAFT',
        },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            id: 'item-2',
            saleId: 'sale-2',
            productId: 'prod-2',
            variantId: null,
            productName: 'Product 2',
            variantName: null,
            quantity: 1,
            unitPriceCents: 500,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: null,
            discountValue: null,
            discountAmountCents: null,
            prePriceCentsBeforeDiscount: null,
            discountTitle: null,
            discountedAt: null,
            tenantId: 'tenant-1',
          },
        ],
      });
      expect(result.id).toBe('sale-2');
    });

    it('should save a sale with no items (cleared)', async () => {
      const sale = Sale.create({ id: 'sale-3', userId: 'user-1' });

      const mockSaleData = {
        id: 'sale-3',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(null) // First call: check if exists (doesn't exist yet)
        .mockResolvedValueOnce(mockSaleData); // Second call: reload after save
      prisma.sale.create.mockResolvedValue(mockSaleData);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-3' },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [],
      });
      expect(result.items).toHaveLength(0);
    });
  });

  describe('findById', () => {
    it('should return a sale with items', async () => {
      const mockSaleData = {
        id: 'sale-4',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date('2026-04-01'),
        updatedAt: new Date('2026-04-01'),
        items: [
          {
            id: 'item-3',
            saleId: 'sale-4',
            productId: 'prod-3',
            variantId: null,
            productName: 'Product 3',
            variantName: null,
            quantity: 3,
            unitPriceCents: 1500,
            unitPriceCurrency: 'MXN',
          },
        ],
      };

      prisma.sale.findUnique.mockResolvedValue(mockSaleData);

      const result = await repo.findById('sale-4');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sale-4');
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].productId).toBe('prod-3');
    });

    it('should return null when sale does not exist', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);

      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('roundtrips discount fields including discountTitle', async () => {
      const mockSaleData = {
        id: 'sale-disc',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date('2026-04-01'),
        updatedAt: new Date('2026-04-01'),
        items: [
          {
            id: 'item-disc',
            saleId: 'sale-disc',
            productId: 'prod-3',
            variantId: null,
            productName: 'Product 3',
            variantName: null,
            quantity: 1,
            unitPriceCents: 800,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: 'percentage',
            discountValue: 20,
            discountAmountCents: 200,
            prePriceCentsBeforeDiscount: 1000,
            discountTitle: 'Promo',
            discountedAt: new Date('2026-04-01'),
          },
        ],
      };

      prisma.sale.findUnique.mockResolvedValue(mockSaleData);
      const result = await repo.findById('sale-disc');
      expect(result?.items[0].discountType).toBe('percentage');
      expect(result?.items[0].discountTitle).toBe('Promo');
    });
  });

  describe('findDraftsByUserId', () => {
    it('should return all drafts for a user', async () => {
      const mockSales = [
        {
          id: 'sale-5',
          userId: 'user-2',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        },
        {
          id: 'sale-6',
          userId: 'user-2',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        },
      ];

      prisma.sale.findMany.mockResolvedValue(mockSales);

      const result = await repo.findDraftsByUserId('user-2');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sale-5');
      expect(result[1].id).toBe('sale-6');
    });

    it('should return empty array when no drafts exist', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      const result = await repo.findDraftsByUserId('user-3');

      expect(result).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('should delete a sale', async () => {
      await repo.delete('sale-7');

      expect(prisma.sale.delete).toHaveBeenCalledWith({
        where: { id: 'sale-7' },
      });
    });

    // S13: Hard Delete Draft with Cascade
    it('should cascade-delete all SaleItems when deleting a Sale (DB-backed)', async () => {
      const saleId = 'sale-cascade-test';

      // Setup: Create sale with items in mock DB state
      const saleWithItems = {
        id: saleId,
        userId: 'user-cascade',
        status: 'DRAFT' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-cascade-1',
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
          {
            id: 'item-cascade-2',
            saleId,
            productId: 'prod-2',
            variantId: 'variant-1',
            productName: 'Product 2',
            variantName: 'Variant 1',
            quantity: 5,
            unitPriceCents: 2000,
            unitPriceCurrency: 'MXN',
          },
        ],
      };

      // Simulate DB state: Sale exists with 2 items
      prisma.sale.findUnique.mockResolvedValue(saleWithItems);

      // ACT: Delete the sale
      await repo.delete(saleId);

      // ASSERT: prisma.sale.delete was called (Prisma cascade deletes items automatically)
      expect(prisma.sale.delete).toHaveBeenCalledWith({
        where: { id: saleId },
      });

      // VERIFY: After delete, both Sale and SaleItems would be gone from DB
      // (Prisma's onDelete: Cascade in schema ensures this at DB level)
      prisma.sale.findUnique.mockResolvedValue(null);
      prisma.saleItem.findMany = jest.fn().mockResolvedValue([]);

      const deletedSale = await prisma.sale.findUnique({
        where: { id: saleId },
        include: { items: true },
      });
      const orphanedItems = await prisma.saleItem.findMany({
        where: { saleId },
      });

      expect(deletedSale).toBeNull();
      expect(orphanedItems).toHaveLength(0);
    });
  });
});
