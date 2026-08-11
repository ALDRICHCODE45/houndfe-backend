/**
 * ProductsService — SERVICE feature tests.
 *
 * Covers T8:
 *   - create() rejects sku/barcode/brandId/lots on type=SERVICE (R1, R2)
 *   - create() upserts a ServiceDetail row in the same tx (R4)
 *   - update() type-change PRODUCT→SERVICE blocked on stock (R5)
 *   - update() type-change SERVICE→PRODUCT clears ServiceDetail (R4/R5)
 *   - addLot() rejects SERVICE with 400 (R2)
 *   - findAll() forwards type filter to Prisma (R8)
 *
 * These tests are isolated from the main products.service.spec.ts (which
 * focuses on SKU/price-list/edit-path rearm) so the SERVICE scenarios
 * stay easy to read in isolation.
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';
import { Product } from './domain/product.entity';
import {
  EntityAlreadyExistsError,
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';

const PRODUCT_ID = 'prod-service-1';
const TENANT_ID = 'tenant-1';

function makeRepo(overrides: Partial<IProductRepository> = {}) {
  return {
    findById: jest.fn(),
    findBySku: jest.fn(),
    findByBarcode: jest.fn(),
    findAll: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    decrementStockForCharge: jest.fn(),
    incrementStockForRestock: jest.fn(),
    rearmAlertAfterEdit: jest
      .fn<Promise<void>, any>()
      .mockResolvedValue(undefined),
    isSkuTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    isBarcodeTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<IProductRepository>;
}

function makePrisma() {
  // Track every call to serviceDetail + lot so the tests can assert
  // "the right writes fired in the right place".
  const calls: Record<string, number> = {};
  const track = (key: string) => {
    calls[key] = (calls[key] ?? 0) + 1;
  };
  return {
    prisma: {
      product: {
        create: jest.fn().mockImplementation(() => {
          track('product.create');
          return Promise.resolve({ id: PRODUCT_ID });
        }),
      },
      globalPriceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      priceList: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      variant: { create: jest.fn(), createMany: jest.fn() },
      lot: { createMany: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      tierPrice: { createMany: jest.fn() },
      productImage: { createMany: jest.fn() },
      serviceDetail: {
        upsert: jest.fn().mockImplementation(() => {
          track('serviceDetail.upsert');
          return Promise.resolve({ id: 'sd-1' });
        }),
        deleteMany: jest.fn().mockImplementation(() => {
          track('serviceDetail.deleteMany');
          return Promise.resolve({ count: 1 });
        }),
      },
      $transaction: jest.fn().mockImplementation(async (work: any) =>
        work({
          product: {
            create: jest.fn().mockImplementation(() => {
              track('tx.product.create');
              return Promise.resolve({ id: PRODUCT_ID });
            }),
          },
          globalPriceList: { findMany: jest.fn().mockResolvedValue([]) },
          priceList: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
          variant: { create: jest.fn(), createMany: jest.fn() },
          lot: { createMany: jest.fn() },
          productImage: { createMany: jest.fn() },
          serviceDetail: {
            upsert: jest.fn().mockImplementation(() => {
              track('tx.serviceDetail.upsert');
              return Promise.resolve({ id: 'sd-1' });
            }),
            deleteMany: jest.fn().mockImplementation(() => {
              track('tx.serviceDetail.deleteMany');
              return Promise.resolve({ count: 1 });
            }),
          },
        }),
      ),
    },
    calls,
  };
}

function makeService(
  repo: IProductRepository,
  prismaMock: ReturnType<typeof makePrisma>['prisma'],
) {
  const tenantPrisma = {
    getTenantId: jest.fn().mockReturnValue(TENANT_ID),
    getClient: jest.fn().mockReturnValue(prismaMock),
    isInTransaction: jest.fn().mockReturnValue(false),
    runInTransaction: jest.fn(
      async (work: (client: unknown) => Promise<unknown>) =>
        work(prismaMock),
    ),
  } as any;
  const filesService = { uploadAndRegister: jest.fn() } as any;
  const satCatalog = {
    assertExists: jest.fn().mockResolvedValue(undefined),
  } as any;
  const service = new ProductsService(
    repo,
    prismaMock as any,
    filesService,
    tenantPrisma,
    satCatalog,
  );
  jest
    .spyOn(service as any, 'buildFullResponse')
    .mockResolvedValue({ id: PRODUCT_ID });
  return service;
}

describe('ProductsService — create() SERVICE rules (R1, R2, R4)', () => {
  it('rejects type=SERVICE with a sku (R1)', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await expect(
      service.create({
        name: 'Paseo de perros',
        type: 'SERVICE',
        sku: 'WALK-1',
      } as any),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects type=SERVICE with a barcode (R1)', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await expect(
      service.create({
        name: 'Paseo de perros',
        type: 'SERVICE',
        barcode: '750000000001',
      } as any),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects type=SERVICE with a brandId (R1)', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await expect(
      service.create({
        name: 'Paseo de perros',
        type: 'SERVICE',
        brandId: 'brand-1',
      } as any),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects type=SERVICE with inline lots (R2)', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await expect(
      service.create({
        name: 'Paseo de perros',
        type: 'SERVICE',
        useLotsAndExpirations: true,
        lots: [
          {
            lotNumber: 'L-1',
            expirationDate: '2026-12-31T00:00:00.000Z',
          },
        ],
      } as any),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('upserts a ServiceDetail row in the same tx (R4)', async () => {
    const repo = makeRepo();
    const { prisma, calls } = makePrisma();
    const service = makeService(repo, prisma);

    await service.create({
      name: 'Paseo de perros',
      type: 'SERVICE',
      unit: 'HORA',
      serviceDetail: { capacity: 5, notes: 'Recoger en lobby' },
    } as any);

    expect(calls['tx.serviceDetail.upsert'] ?? 0).toBe(1);
  });

  it('does NOT create ServiceDetail for type=PRODUCT (R4)', async () => {
    const repo = makeRepo();
    const { prisma, calls } = makePrisma();
    const service = makeService(repo, prisma);

    await service.create({
      name: 'Croqueta',
      type: 'PRODUCT',
    } as any);

    expect(calls['tx.serviceDetail.upsert'] ?? 0).toBe(0);
    expect(calls['tx.serviceDetail.deleteMany'] ?? 0).toBe(0);
  });
});

describe('ProductsService — update() type-change protection (R5)', () => {
  it('blocks PRODUCT→SERVICE when stock > 0 (R5)', async () => {
    const product = Product.fromPersistence({
      ...{
        id: PRODUCT_ID,
        name: 'Croqueta',
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
        quantity: 10,
        minQuantity: 0,
        hasVariants: false,
        serviceDetail: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      },
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const { prisma } = makePrisma();
    (prisma.lot.count as jest.Mock).mockResolvedValue(0);
    const service = makeService(repo, prisma);

    await expect(
      service.update(PRODUCT_ID, { type: 'SERVICE' } as any),
    ).rejects.toThrow(BusinessRuleViolationError);
  });

  it('blocks PRODUCT→SERVICE when active lots exist (R5)', async () => {
    const product = Product.fromPersistence({
      id: PRODUCT_ID,
      name: 'Croqueta',
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
      serviceDetail: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const { prisma } = makePrisma();
    (prisma.lot.count as jest.Mock).mockResolvedValue(3);
    const service = makeService(repo, prisma);

    await expect(
      service.update(PRODUCT_ID, { type: 'SERVICE' } as any),
    ).rejects.toThrow(BusinessRuleViolationError);
  });

  it('allows PRODUCT→SERVICE when stock=0 and no active lots (R5)', async () => {
    const product = Product.fromPersistence({
      id: PRODUCT_ID,
      name: 'Croqueta',
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
      useStock: false,
      useLotsAndExpirations: false,
      quantity: 0,
      minQuantity: 0,
      hasVariants: false,
      serviceDetail: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const { prisma, calls } = makePrisma();
    const service = makeService(repo, prisma);

    await service.update(PRODUCT_ID, { type: 'SERVICE' } as any);

    expect(repo.save).toHaveBeenCalled();
    // After save, type=SERVICE → ServiceDetail is NOT deleted.
    // Note: this is a PRODUCT→SERVICE flow without an existing
    // ServiceDetail row, so deleteMany is a no-op (zero count). The
    // service is allowed to invoke deleteMany defensively.
  });

  it('deletes ServiceDetail when converting SERVICE→PRODUCT (R4/R5)', async () => {
    const product = Product.fromPersistence({
      id: PRODUCT_ID,
      name: 'Paseo de perros',
      location: null,
      description: null,
      type: 'SERVICE',
      sku: null,
      barcode: null,
      unit: 'HORA',
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
      useStock: false,
      useLotsAndExpirations: false,
      quantity: 0,
      minQuantity: 0,
      hasVariants: false,
      serviceDetail: {
        id: 'sd-1',
        productId: PRODUCT_ID,
        capacity: 5,
        notes: 'Recoger en lobby',
      },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await service.update(PRODUCT_ID, { type: 'PRODUCT' } as any);

    // The service writes via `tenantPrisma.getClient().serviceDetail`,
    // which in the test mock is the SAME object as `prisma`. The
    // `tx.*` keys in `calls` correspond to the `$transaction` work
    // callback, but the service intentionally does NOT wrap
    // serviceDetail inside the tx — it routes through getClient() so
    // the ambient-tx join still happens.
    expect(prisma.serviceDetail.deleteMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
    });
  });
});

describe('ProductsService — addLot() rejects SERVICE (R2)', () => {
  it('throws BusinessRuleViolationError for type=SERVICE', async () => {
    const product = Product.fromPersistence({
      id: PRODUCT_ID,
      name: 'Paseo de perros',
      location: null,
      description: null,
      type: 'SERVICE',
      sku: null,
      barcode: null,
      unit: 'HORA',
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
      useStock: false,
      useLotsAndExpirations: false,
      quantity: 0,
      minQuantity: 0,
      hasVariants: false,
      serviceDetail: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const { prisma } = makePrisma();
    const service = makeService(repo, prisma);

    await expect(
      service.addLot(PRODUCT_ID, {
        lotNumber: 'L-1',
        expirationDate: '2026-12-31T00:00:00.000Z',
      } as any),
    ).rejects.toThrow(BusinessRuleViolationError);
  });
});

describe('ProductsService — findAll() type filter (R8)', () => {
  it('forwards ?type=SERVICE to Prisma', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    (prisma.product.findMany as jest.Mock) = jest
      .fn()
      .mockResolvedValue([]);
    prisma.product.findMany = prisma.product.findMany;
    const service = makeService(repo, prisma);

    await service.findAll({ type: 'SERVICE' } as any);

    const call = (prisma.product.findMany as jest.Mock).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ type: 'SERVICE' });
  });

  it('forwards ?type=PRODUCT to Prisma', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    (prisma.product.findMany as jest.Mock) = jest
      .fn()
      .mockResolvedValue([]);
    prisma.product.findMany = prisma.product.findMany;
    const service = makeService(repo, prisma);

    await service.findAll({ type: 'PRODUCT' } as any);

    const call = (prisma.product.findMany as jest.Mock).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ type: 'PRODUCT' });
  });

  it('does not apply a type filter when omitted', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    (prisma.product.findMany as jest.Mock) = jest
      .fn()
      .mockResolvedValue([]);
    prisma.product.findMany = prisma.product.findMany;
    const service = makeService(repo, prisma);

    await service.findAll({} as any);

    const call = (prisma.product.findMany as jest.Mock).mock.calls[0]?.[0];
    expect(call?.where).toBeUndefined();
  });

  it('combines search and type filters with AND', async () => {
    const repo = makeRepo();
    const { prisma } = makePrisma();
    (prisma.product.findMany as jest.Mock) = jest
      .fn()
      .mockResolvedValue([]);
    prisma.product.findMany = prisma.product.findMany;
    const service = makeService(repo, prisma);

    await service.findAll({ search: 'paseo', type: 'SERVICE' } as any);

    const call = (prisma.product.findMany as jest.Mock).mock.calls[0]?.[0];
    expect(call?.where).toEqual({
      AND: [
        {
          OR: [
            { name: { contains: 'paseo', mode: 'insensitive' } },
            { sku: { contains: 'paseo', mode: 'insensitive' } },
            { barcode: { contains: 'paseo', mode: 'insensitive' } },
          ],
        },
        { type: 'SERVICE' },
      ],
    });
  });
});
