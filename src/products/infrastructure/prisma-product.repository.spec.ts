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
    },
    variant: {
      findFirst: jest.fn(),
    },
  } as any;

  return {
    getClient: jest.fn().mockReturnValue(client),
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
        create: expect.not.objectContaining({ tenantId: expect.anything() }),
      }),
    );
  });
});
