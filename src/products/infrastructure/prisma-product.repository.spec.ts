import { Product } from '../domain/product.entity';
import { PrismaProductRepository } from './prisma-product.repository';

function makeTenantPrismaMock() {
  const client = {
    product: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    variant: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  } as any;

  return {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    client,
  };
}

describe('PrismaProductRepository tenant scoping', () => {
  it('uses TenantPrismaService client and does not require tenantId on create', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    const product = Product.create({ id: 'prod-1', name: 'Shampoo' });

    tenantPrisma.client.product.upsert.mockResolvedValue({
      id: 'prod-1',
      name: 'Shampoo',
      location: null,
      description: null,
      type: 'PRODUCT',
      sku: null,
      barcode: null,
      unit: 'UNIDAD',
      satKey: null,
      categoryId: null,
      brandId: null,
      sellInPos: true,
      includeInOnlineCatalog: true,
      requiresPrescription: false,
      chargeProductTaxes: true,
      ivaRate: 'IVA_16',
      iepsRate: 'NO_APLICA',
      purchaseCostMode: 'NET',
      purchaseNetCostCents: 0,
      purchaseGrossCostCents: 0,
      useStock: true,
      useLotsAndExpirations: false,
      quantity: 0,
      minQuantity: 0,
      hasVariants: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const repo = new PrismaProductRepository(tenantPrisma as any);
    await repo.save(product);

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(tenantPrisma.client.product.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
  });

  it('decrements stock atomically and fails on insufficient stock', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.product.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const repo = new PrismaProductRepository(tenantPrisma as any);

    await expect(
      repo.decrementStockForCharge([
        { productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', quantity: 3 },
      ]),
    ).rejects.toThrow('STOCK_INSUFFICIENT_AT_CONFIRM');
  });

  it('increments variant stock for restock adjustments', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.variant.updateMany.mockResolvedValue({ count: 1 });

    const repo = new PrismaProductRepository(tenantPrisma as any);

    await repo.incrementStockForRestock([
      { productId: 'prod-1', variantId: 'var-1', quantity: 4 },
    ]);

    expect(tenantPrisma.client.variant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'var-1',
        productId: 'prod-1',
        tenantId: 'tenant-1',
      },
      data: {
        quantity: { increment: 4 },
      },
    });
  });

  it('increments product stock for restock adjustments when useStock is enabled', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.product.updateMany.mockResolvedValue({ count: 1 });

    const repo = new PrismaProductRepository(tenantPrisma as any);

    await repo.incrementStockForRestock([{ productId: 'prod-2', quantity: 3 }]);

    expect(tenantPrisma.client.product.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'prod-2',
        tenantId: 'tenant-1',
        useStock: true,
      },
      data: {
        quantity: { increment: 3 },
      },
    });
  });

  it('skips non-stock products during restock without raising an error', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.product.updateMany.mockResolvedValue({ count: 0 });

    const repo = new PrismaProductRepository(tenantPrisma as any);

    await expect(
      repo.incrementStockForRestock([{ productId: 'prod-3', quantity: 2 }]),
    ).resolves.toBeUndefined();

    expect(tenantPrisma.client.product.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'prod-3',
        tenantId: 'tenant-1',
        useStock: true,
      },
      data: {
        quantity: { increment: 2 },
      },
    });
  });
});
