/**
 * ProductsService — Variant SKU/Barcode Uniqueness Tests
 *
 * Validates W-02 fix: updateVariant must correctly exclude only the variant
 * being updated, rejecting duplicates against sibling variants and parent product.
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';
import {
  EntityAlreadyExistsError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import { Product } from './domain/product.entity';
import { BadRequestException } from '@nestjs/common';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import type { IStockAlertStateRepository } from '../stock-alerts/domain/stock-alert-state.repository';

// ── Minimal mocks ──────────────────────────────────────────────────────

const PRODUCT_ID = 'prod-1';
const VARIANT_A_ID = 'var-a';
const VARIANT_B_ID = 'var-b';

function makeMockRepo(overrides: Partial<IProductRepository> = {}) {
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

function makeMockPrisma() {
  return {
    variant: {
      findFirst: jest.fn().mockResolvedValue({
        id: VARIANT_A_ID,
        productId: PRODUCT_ID,
        name: 'Red',
        sku: 'SKU-RED',
        barcode: 'BC-RED',
        quantity: 10,
      }),
      update: jest.fn().mockImplementation((_args: any) =>
        Promise.resolve({
          id: VARIANT_A_ID,
          productId: PRODUCT_ID,
          name: 'Red',
          sku: 'SKU-RED',
          barcode: 'BC-RED',
          quantity: 10,
        }),
      ),
    },
  } as any;
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
  filesService?: ReturnType<typeof makeMockFilesService>,
  satCatalog?: any,
) {
  // Edit-path tests need `runInTransaction` to be a passthrough so
  // that the production code's wrap is exercised without an actual
  // CLS-backed tx. The default impl here lets `runInTransaction(work)`
  // just call `work(prisma)` synchronously — tests that need to
  // assert the wrap (count calls, route writes through a tx client)
  // override the instance field after construction.
  const tenantPrisma = {
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
    isInTransaction: jest.fn().mockReturnValue(false),
    runInTransaction: jest.fn(
      async (work: (client: ReturnType<typeof getClient>) => Promise<unknown>) =>
        work(prisma),
    ),
  } as any;
  return new ProductsService(
    repo,
    prisma,
    filesService ?? makeMockFilesService(),
    tenantPrisma,
    satCatalog ?? makeNoopSatCatalog(),
  );
}

function makeNoopSatCatalog() {
  return {
    assertExists: jest.fn().mockResolvedValue(undefined),
    search: jest.fn(),
    findByKey: jest.fn(),
  } as any;
}

function makeProduct(id = PRODUCT_ID) {
  return Product.create({ id, name: 'Product 1' });
}

function makePersistenceProduct(
  overrides: Partial<{
    id: string;
    name: string;
    quantity: number;
    hasVariants: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) {
  const now = new Date('2026-04-01T10:00:00.000Z');

  return {
    id: overrides.id ?? 'prod-default',
    name: overrides.name ?? 'Producto',
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
    quantity: overrides.quantity ?? 0,
    minQuantity: 0,
    hasVariants: overrides.hasVariants ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProductsService — updateVariant uniqueness', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: ProductsService;

  beforeEach(() => {
    repo = makeMockRepo();
    prisma = makeMockPrisma();
    service = createService(repo, prisma);
  });

  // ── SKU ──

  describe('SKU uniqueness on variant update', () => {
    it('should pass when updating variant with its own unchanged SKU', async () => {
      // isSkuTaken returns false because the only match IS the variant itself (excluded)
      repo.isSkuTaken.mockResolvedValue(false);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { sku: 'SKU-RED' }),
      ).resolves.toBeDefined();

      // Must pass variantId (NOT productId) so only this variant is excluded
      expect(repo.isSkuTaken).toHaveBeenCalledWith('SKU-RED', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should reject when updating variant to a sibling variant SKU', async () => {
      // Sibling variant "Blue" has SKU-BLUE → repo says taken
      repo.isSkuTaken.mockResolvedValue(true);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { sku: 'SKU-BLUE' }),
      ).rejects.toThrow(EntityAlreadyExistsError);

      expect(repo.isSkuTaken).toHaveBeenCalledWith('SKU-BLUE', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should reject when updating variant to parent product SKU', async () => {
      // Product has SKU-PROD → repo says taken (no productId exclusion for variant updates)
      repo.isSkuTaken.mockResolvedValue(true);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { sku: 'SKU-PROD' }),
      ).rejects.toThrow(EntityAlreadyExistsError);

      // Critically: only variantId is passed, NOT productId — so parent product is NOT excluded
      expect(repo.isSkuTaken).toHaveBeenCalledWith('SKU-PROD', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should NOT call isSkuTaken when sku is undefined (not being updated)', async () => {
      await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { name: 'Rojo' });
      expect(repo.isSkuTaken).not.toHaveBeenCalled();
    });
  });

  // ── Barcode ──

  describe('Barcode uniqueness on variant update', () => {
    it('should pass when updating variant with its own unchanged barcode', async () => {
      repo.isBarcodeTaken.mockResolvedValue(false);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { barcode: 'BC-RED' }),
      ).resolves.toBeDefined();

      expect(repo.isBarcodeTaken).toHaveBeenCalledWith('BC-RED', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should reject when updating variant to sibling variant barcode', async () => {
      repo.isBarcodeTaken.mockResolvedValue(true);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
          barcode: 'BC-BLUE',
        }),
      ).rejects.toThrow(EntityAlreadyExistsError);

      expect(repo.isBarcodeTaken).toHaveBeenCalledWith('BC-BLUE', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should reject when updating variant to parent product barcode', async () => {
      repo.isBarcodeTaken.mockResolvedValue(true);

      await expect(
        service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
          barcode: 'BC-PROD',
        }),
      ).rejects.toThrow(EntityAlreadyExistsError);

      expect(repo.isBarcodeTaken).toHaveBeenCalledWith('BC-PROD', {
        variantId: VARIANT_A_ID,
      });
    });

    it('should NOT call isBarcodeTaken when barcode is undefined', async () => {
      await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { name: 'Rojo' });
      expect(repo.isBarcodeTaken).not.toHaveBeenCalled();
    });
  });
});

describe('ProductsService — stock adjustments', () => {
  it('delegates restock increments to the product repository', async () => {
    const repo = makeMockRepo();
    repo.incrementStockForRestock.mockResolvedValue(undefined);

    const service = createService(repo, makeMockPrisma());
    const adjustments = [{ productId: 'prod-1', variantId: 'var-1', quantity: 2 }];

    await service.incrementStockForRestock(adjustments);

    expect(repo.incrementStockForRestock).toHaveBeenCalledWith(adjustments);
  });
});

describe('ProductsService — findAll variant aggregates', () => {
  it('should resolve reads through tenant prisma client', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const tenantPrisma = {
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      getClient: jest.fn().mockReturnValue(prisma),
    } as any;

    const service = new ProductsService(
      repo,
      prisma,
      makeMockFilesService(),
      tenantPrisma,
      makeNoopSatCatalog(),
    );

    await service.findAll();

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(prisma.product.findMany).toHaveBeenCalled();
  });

  it('should return variantStockTotal=30 and variantCount=2 for product with variants', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-variants-2',
              hasVariants: true,
              quantity: 0,
            }),
            _count: { variants: 2 },
            variants: [{ quantity: 10 }, { quantity: 20 }],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);

    const [result] = await service.findAll();

    expect(result.hasVariants).toBe(true);
    expect(result).toHaveProperty('variantStockTotal', 30);
    expect(result).toHaveProperty('variantCount', 2);
    expect(repo.findAll).not.toHaveBeenCalled();
  });

  it('should return zero aggregates when hasVariants=true and product has no variants', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-variants-0',
              hasVariants: true,
              quantity: 0,
            }),
            _count: { variants: 0 },
            variants: [],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);

    const [result] = await service.findAll();

    expect(result.hasVariants).toBe(true);
    expect(result).toHaveProperty('variantStockTotal', 0);
    expect(result).toHaveProperty('variantCount', 0);
  });

  it('should omit variant aggregate keys when hasVariants=false', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-no-variants',
              hasVariants: false,
              quantity: 33,
            }),
            _count: { variants: 0 },
            variants: [],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);

    const [result] = await service.findAll();

    expect(result.hasVariants).toBe(false);
    expect(result.quantity).toBe(33);
    expect(result).not.toHaveProperty('variantStockTotal');
    expect(result).not.toHaveProperty('variantCount');
  });

  it('should compute aggregates independently for multiple products', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-a',
              hasVariants: true,
              quantity: 0,
            }),
            _count: { variants: 2 },
            variants: [{ quantity: 5 }, { quantity: 7 }],
          },
          {
            ...makePersistenceProduct({
              id: 'prod-b',
              hasVariants: true,
              quantity: 0,
            }),
            _count: { variants: 3 },
            variants: [{ quantity: 1 }, { quantity: 2 }, { quantity: 3 }],
          },
          {
            ...makePersistenceProduct({
              id: 'prod-c',
              hasVariants: false,
              quantity: 11,
            }),
            _count: { variants: 0 },
            variants: [],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);

    const [productA, productB, productC] = await service.findAll();

    expect(productA.id).toBe('prod-a');
    expect(productA).toHaveProperty('variantStockTotal', 12);
    expect(productA).toHaveProperty('variantCount', 2);

    expect(productB.id).toBe('prod-b');
    expect(productB).toHaveProperty('variantStockTotal', 6);
    expect(productB).toHaveProperty('variantCount', 3);

    expect(productC.id).toBe('prod-c');
    expect(productC).not.toHaveProperty('variantStockTotal');
    expect(productC).not.toHaveProperty('variantCount');
  });
});

describe('ProductsService — priceCents from PUBLICO list', () => {
  it('findAll should include priceCents and priceDecimal from PUBLICO list', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-publico-price',
              hasVariants: false,
              quantity: 10,
            }),
            _count: { variants: 0 },
            variants: [],
            priceLists: [{ priceCents: 30000 }],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);
    const [result] = await service.findAll();

    expect(result).toHaveProperty('priceCents', 30000);
    expect(result).toHaveProperty('priceDecimal', 300);
  });

  it('findAll should default priceCents to 0 when no PUBLICO list found', async () => {
    const repo = makeMockRepo();
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...makePersistenceProduct({
              id: 'prod-no-publico-price',
              hasVariants: false,
            }),
            _count: { variants: 0 },
            variants: [],
            priceLists: [],
          },
        ]),
      },
    } as any;

    const service = createService(repo, prisma);
    const [result] = await service.findAll();

    expect(result).toHaveProperty('priceCents', 0);
    expect(result).toHaveProperty('priceDecimal', 0);
  });
});

describe('ProductsService — image ownership validation', () => {
  it('should reject image creation when variant does not belong to product', async () => {
    const repo = makeMockRepo({
      findById: jest
        .fn()
        .mockResolvedValue(Product.create({ id: PRODUCT_ID, name: 'P1' })),
    });

    const prisma = {
      variant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      productImage: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = createService(repo, prisma);

    await expect(
      service.addImage(PRODUCT_ID, {
        url: 'https://cdn.test/image.jpg',
        variantId: VARIANT_B_ID,
      }),
    ).rejects.toThrow(BusinessRuleViolationError);

    expect(prisma.productImage.create).not.toHaveBeenCalled();
  });
});

describe('ProductsService — pricing contract math', () => {
  it('should calculate margin amounts and integer percent for price list and tiers', () => {
    const repo = makeMockRepo();
    const prisma = makeMockPrisma();
    const service = createService(repo, prisma);

    const product = Product.create({
      id: PRODUCT_ID,
      name: 'P1',
      purchaseCostMode: 'NET',
      purchaseCostValue: 1000,
    });

    const enriched = (service as any).enrichPriceListResponse(
      {
        id: 'pl-1',
        productId: PRODUCT_ID,
        globalPriceList: { name: 'PUBLICO' },
        priceCents: 1999,
        tierPrices: [
          { id: 't1', minQuantity: 0, priceCents: 1500 },
          { id: 't2', minQuantity: 10, priceCents: 0 },
        ],
      },
      product,
    );

    expect(enriched.margin).toEqual({
      amountCents: 999,
      amountDecimal: 9.99,
      percent: 50,
    });

    expect(enriched.tierPrices[0].margin).toEqual({
      amountCents: 500,
      amountDecimal: 5,
      percent: 33,
    });

    expect(enriched.tierPrices[1].margin.percent).toBe(0);
    expect(Number.isInteger(enriched.margin.percent)).toBe(true);
    expect(Number.isInteger(enriched.tierPrices[0].margin.percent)).toBe(true);
  });
});

describe('ProductsService — variant naming policy', () => {
  it('should persist name from value when option and value are provided', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockResolvedValue({ id: VARIANT_A_ID }),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);

    await service.addVariant(PRODUCT_ID, {
      name: 'Legacy Name',
      option: 'Color',
      value: 'Rojo',
      quantity: 0,
    });

    expect(tx.variant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Rojo',
          option: 'Color',
          value: 'Rojo',
        }),
      }),
    );
  });
});

describe('ProductsService — variant price matrix auto-create', () => {
  it('should create zeroed variant prices for all existing price lists on variant creation', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockResolvedValue({ id: VARIANT_A_ID }),
      },
      priceList: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'pl-publico' }, { id: 'pl-mayoreo' }]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);

    await service.addVariant(PRODUCT_ID, { name: 'Rojo' });

    expect(tx.variantPrice.createMany).toHaveBeenCalledWith({
      data: [
        {
          variantId: VARIANT_A_ID,
          priceListId: 'pl-publico',
          priceCents: 0,
          tenantId: 'tenant-1',
        },
        {
          variantId: VARIANT_A_ID,
          priceListId: 'pl-mayoreo',
          priceCents: 0,
          tenantId: 'tenant-1',
        },
      ],
    });
  });

  it('should create product price lists for all global lists', async () => {
    const repo = makeMockRepo();

    const tx = {
      product: {
        create: jest.fn().mockResolvedValue({ id: PRODUCT_ID }),
      },
      globalPriceList: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'gl-publico', isDefault: true },
          { id: 'gl-mayoreo', isDefault: false },
        ]),
      },
      priceList: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);
    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    await service.create({ name: 'Producto', priceCents: 1999 });

    expect(tx.priceList.createMany).toHaveBeenCalledTimes(1);
    const callData = tx.priceList.createMany.mock.calls[0][0].data;
    expect(callData).toHaveLength(2);
    // Same productId for both entries
    expect(callData[0].productId).toBe(callData[1].productId);
    // Correct global list mappings and prices
    expect(callData[0]).toMatchObject({
      globalPriceListId: 'gl-publico',
      priceCents: 1999,
    });
    expect(callData[1]).toMatchObject({
      globalPriceListId: 'gl-mayoreo',
      priceCents: 0,
    });
  });

  it('update should redirect priceCents to PUBLICO list', async () => {
    const product = makeProduct();
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(product),
      save: jest.fn().mockResolvedValue(product),
    });

    const prisma = {
      globalPriceList: {
        findFirst: jest.fn().mockResolvedValue({ id: 'gl-publico' }),
      },
      priceList: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;

    const service = createService(repo, prisma);
    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    await service.update(PRODUCT_ID, { priceCents: 50000 });

    expect(prisma.globalPriceList.findFirst).toHaveBeenCalledWith({
      where: { isDefault: true },
      select: { id: true },
    });
    expect(prisma.priceList.updateMany).toHaveBeenCalledWith({
      where: {
        productId: PRODUCT_ID,
        globalPriceListId: 'gl-publico',
      },
      data: { priceCents: 50000 },
    });
  });
});

describe('ProductsService — variant minQuantity and purchase cost', () => {
  it('should create variant with explicit minQuantity', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: data.name,
            option: data.option,
            value: data.value,
            sku: data.sku,
            barcode: data.barcode,
            quantity: data.quantity,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: data.purchaseNetCostCents,
          }),
        ),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);

    const created: any = await service.addVariant(PRODUCT_ID, {
      name: 'Rojo',
      minQuantity: 5,
    });

    expect(created.minQuantity).toBe(5);
  });

  it('should default minQuantity to zero when omitted', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: data.name,
            sku: data.sku,
            barcode: data.barcode,
            quantity: data.quantity,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: data.purchaseNetCostCents,
          }),
        ),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);

    const created: any = await service.addVariant(PRODUCT_ID, {
      name: 'Rojo',
    });

    expect(created.minQuantity).toBe(0);
  });

  it('should normalize variant minQuantity to zero when product useStock is false', async () => {
    const repo = makeMockRepo({
      findById: jest
        .fn()
        .mockResolvedValue(
          Product.create({ id: PRODUCT_ID, name: 'P1', useStock: false }),
        ),
    });

    const tx = {
      variant: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: data.name,
            quantity: data.quantity,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: data.purchaseNetCostCents,
            sku: data.sku,
            barcode: data.barcode,
          }),
        ),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);

    const created: any = await service.addVariant(PRODUCT_ID, {
      name: 'Rojo',
      minQuantity: 9,
    });

    expect(created.minQuantity).toBe(0);
  });

  it('should update variant minQuantity', async () => {
    const repo = makeMockRepo();

    const prisma = {
      variant: {
        findFirst: jest.fn().mockResolvedValue({
          id: VARIANT_A_ID,
          productId: PRODUCT_ID,
          name: 'Red',
          option: null,
          value: null,
          sku: 'SKU-RED',
          barcode: 'BC-RED',
          quantity: 10,
          minQuantity: 1,
          purchaseNetCostCents: null,
          product: { useStock: true },
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: 'Red',
            option: null,
            value: null,
            sku: 'SKU-RED',
            barcode: 'BC-RED',
            quantity: 10,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: null,
          }),
        ),
      },
    } as any;

    const service = createService(repo, prisma);
    const updated: any = await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
      minQuantity: 10,
    });

    expect(updated.minQuantity).toBe(10);
  });

  it('should cascade minQuantity reset on product useStock false', async () => {
    const repo = makeMockRepo({
      findById: jest
        .fn()
        .mockResolvedValue(
          Product.create({ id: PRODUCT_ID, name: 'P1', useStock: true }),
        ),
      save: jest.fn().mockResolvedValue(makeProduct()),
    });

    const prisma = {
      variant: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as any;

    const service = createService(repo, prisma);
    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    await service.update(PRODUCT_ID, { useStock: false });

    expect(prisma.variant.updateMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
      data: { minQuantity: 0 },
    });
  });

  it('should return purchaseNetCostCents null and null decimal when omitted', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: data.name,
            quantity: data.quantity,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: data.purchaseNetCostCents,
            sku: data.sku,
            barcode: data.barcode,
          }),
        ),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);
    const created = await service.addVariant(PRODUCT_ID, { name: 'Rojo' });

    expect(created.purchaseNetCostCents).toBeNull();
    expect(created.purchaseNetCostDecimal).toBeNull();
  });

  it('should return purchaseNetCostDecimal from variant override cost', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variant: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: data.name,
            quantity: data.quantity,
            minQuantity: data.minQuantity,
            purchaseNetCostCents: data.purchaseNetCostCents,
            sku: data.sku,
            barcode: data.barcode,
          }),
        ),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      variantPrice: {
        createMany: jest.fn(),
      },
      product: {
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    const service = createService(repo, prisma);
    const created = await service.addVariant(PRODUCT_ID, {
      name: 'Rojo',
      purchaseNetCostCents: 4500,
    });

    expect(created.purchaseNetCostCents).toBe(4500);
    expect(created.purchaseNetCostDecimal).toBe(45);
  });

  it('should calculate variant margin using variant purchase cost override', () => {
    const repo = makeMockRepo();
    const prisma = makeMockPrisma();
    const service = createService(repo, prisma);
    const product = Product.create({
      id: PRODUCT_ID,
      name: 'P1',
      purchaseCostMode: 'NET',
      purchaseCostValue: 3000,
    });

    const enriched = (service as any).enrichVariantPriceResponse(
      {
        id: 'vp-1',
        variantId: VARIANT_A_ID,
        priceListId: 'pl-1',
        priceCents: 9900,
        priceList: { id: 'pl-1', globalPriceList: { name: 'PUBLICO' } },
        tierPrices: [{ id: 'vt-1', minQuantity: 0, priceCents: 9900 }],
      },
      product,
      4500,
    );

    expect(enriched.margin.amountCents).toBe(5400);
    expect(enriched.tierPrices[0].margin.amountCents).toBe(5400);
  });

  it('should calculate variant margin using product purchase cost when override is null', () => {
    const repo = makeMockRepo();
    const prisma = makeMockPrisma();
    const service = createService(repo, prisma);
    const product = Product.create({
      id: PRODUCT_ID,
      name: 'P1',
      purchaseCostMode: 'NET',
      purchaseCostValue: 3000,
    });

    const enriched = (service as any).enrichVariantPriceResponse(
      {
        id: 'vp-1',
        variantId: VARIANT_A_ID,
        priceListId: 'pl-1',
        priceCents: 9900,
        priceList: { id: 'pl-1', globalPriceList: { name: 'PUBLICO' } },
        tierPrices: [],
      },
      product,
      null,
    );

    expect(enriched.margin.amountCents).toBe(6900);
  });

  it('should update variant purchaseNetCostCents with zero', async () => {
    const repo = makeMockRepo();

    const prisma = {
      variant: {
        findFirst: jest.fn().mockResolvedValue({
          id: VARIANT_A_ID,
          productId: PRODUCT_ID,
          name: 'Red',
          option: null,
          value: null,
          sku: 'SKU-RED',
          barcode: 'BC-RED',
          quantity: 10,
          minQuantity: 1,
          purchaseNetCostCents: 4500,
          product: { useStock: true },
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: 'Red',
            option: null,
            value: null,
            sku: 'SKU-RED',
            barcode: 'BC-RED',
            quantity: 10,
            minQuantity: 1,
            purchaseNetCostCents: data.purchaseNetCostCents,
          }),
        ),
      },
    } as any;

    const service = createService(repo, prisma);
    const updated = await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
      purchaseNetCostCents: 0,
    });

    expect(updated.purchaseNetCostCents).toBe(0);
    expect(updated.purchaseNetCostDecimal).toBe(0);
  });

  it('should update variant purchaseNetCostCents with null to inherit product cost', async () => {
    const repo = makeMockRepo();

    const prisma = {
      variant: {
        findFirst: jest.fn().mockResolvedValue({
          id: VARIANT_A_ID,
          productId: PRODUCT_ID,
          name: 'Red',
          option: null,
          value: null,
          sku: 'SKU-RED',
          barcode: 'BC-RED',
          quantity: 10,
          minQuantity: 1,
          purchaseNetCostCents: 4500,
          product: { useStock: true },
        }),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: VARIANT_A_ID,
            productId: PRODUCT_ID,
            name: 'Red',
            option: null,
            value: null,
            sku: 'SKU-RED',
            barcode: 'BC-RED',
            quantity: 10,
            minQuantity: 1,
            purchaseNetCostCents: data.purchaseNetCostCents,
          }),
        ),
      },
    } as any;

    const service = createService(repo, prisma);
    const updated = await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
      purchaseNetCostCents: null,
    });

    expect(updated.purchaseNetCostCents).toBeNull();
    expect(updated.purchaseNetCostDecimal).toBeNull();
  });
});

describe('ProductsService — variant tier upsert 3-state semantics', () => {
  function setup() {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const tx = {
      variantPrice: {
        upsert: jest.fn().mockResolvedValue({ id: 'vp-1' }),
      },
      variantTierPrice: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
    };

    const prisma = {
      variant: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: VARIANT_A_ID, productId: PRODUCT_ID }),
      },
      priceList: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pl-1',
          productId: PRODUCT_ID,
          globalPriceList: { isDefault: false },
        }),
      },
      variantPrice: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'vp-1',
          variantId: VARIANT_A_ID,
          priceListId: 'pl-1',
          priceCents: 1200,
          priceList: { id: 'pl-1', globalPriceList: { name: 'VIP' } },
          tierPrices: [],
        }),
      },
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    } as any;

    return { service: createService(repo, prisma), tx };
  }

  it('omitted tierPrices should keep existing tiers (no tier operations)', async () => {
    const { service, tx } = setup();

    await service.upsertVariantPrice(PRODUCT_ID, VARIANT_A_ID, 'pl-1', {
      priceCents: 1200,
    });

    expect(tx.variantTierPrice.deleteMany).not.toHaveBeenCalled();
    expect(tx.variantTierPrice.createMany).not.toHaveBeenCalled();
  });

  it('empty tierPrices should clear tiers', async () => {
    const { service, tx } = setup();

    await service.upsertVariantPrice(PRODUCT_ID, VARIANT_A_ID, 'pl-1', {
      priceCents: 1200,
      tierPrices: [],
    });

    expect(tx.variantTierPrice.deleteMany).toHaveBeenCalledWith({
      where: { variantPriceId: 'vp-1' },
    });
    expect(tx.variantTierPrice.createMany).not.toHaveBeenCalled();
  });

  it('provided tierPrices should replace tiers', async () => {
    const { service, tx } = setup();

    await service.upsertVariantPrice(PRODUCT_ID, VARIANT_A_ID, 'pl-1', {
      priceCents: 1200,
      tierPrices: [
        { minQuantity: 0, priceCents: 1200 },
        { minQuantity: 10, priceCents: 1000 },
      ],
    });

    expect(tx.variantTierPrice.deleteMany).toHaveBeenCalledWith({
      where: { variantPriceId: 'vp-1' },
    });
    expect(tx.variantTierPrice.createMany).toHaveBeenCalledWith({
      data: [
        {
          variantPriceId: 'vp-1',
          minQuantity: 0,
          priceCents: 1200,
          tenantId: 'tenant-1',
        },
        {
          variantPriceId: 'vp-1',
          minQuantity: 10,
          priceCents: 1000,
          tenantId: 'tenant-1',
        },
      ],
    });
  });
});

describe('ProductsService — variant price delete protection', () => {
  it('should reject deleting PUBLICO variant price', async () => {
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const prisma = {
      variant: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: VARIANT_A_ID, productId: PRODUCT_ID }),
      },
      priceList: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pl-publico',
          productId: PRODUCT_ID,
          globalPriceList: { isDefault: true },
        }),
      },
      variantPrice: {
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    } as any;

    const service = createService(repo, prisma);

    await expect(
      service.removeVariantPrice(PRODUCT_ID, VARIANT_A_ID, 'pl-publico'),
    ).rejects.toMatchObject({
      code: 'DEFAULT_PRICE_LIST_PROTECTED',
    });

    expect(prisma.variantPrice.delete).not.toHaveBeenCalled();
  });
});

// ── Image deletion with file storage integration ──────────────────────

describe('ProductsService - Image deletion with file storage', () => {
  it('should delete associated FileObject when removing image with fileId', async () => {
    // Arrange
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const mockFilesService = {
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const prisma = {
      productImage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'img-1',
          productId: PRODUCT_ID,
          fileId: 'file-123',
          url: 'https://example.com/image.jpg',
        }),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    } as any;

    const service = new ProductsService(
      repo,
      prisma,
      mockFilesService as any,
      {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        getClient: jest.fn().mockReturnValue(prisma),
      } as any,
      makeNoopSatCatalog(),
    );

    // Act
    await service.removeImage(PRODUCT_ID, 'img-1');

    // Assert
    expect(prisma.productImage.delete).toHaveBeenCalledWith({
      where: { id: 'img-1' },
    });
    expect(mockFilesService.delete).toHaveBeenCalledWith('file-123');
  });

  it('should NOT call FilesService when removing image without fileId (legacy URL-only)', async () => {
    // Arrange
    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(makeProduct()),
    });

    const mockFilesService = {
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const prisma = {
      productImage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'img-2',
          productId: PRODUCT_ID,
          fileId: null,
          url: 'https://example.com/legacy.jpg',
        }),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    } as any;

    const service = new ProductsService(
      repo,
      prisma,
      mockFilesService as any,
      {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        getClient: jest.fn().mockReturnValue(prisma),
      } as any,
      makeNoopSatCatalog(),
    );

    // Act
    await service.removeImage(PRODUCT_ID, 'img-2');

    // Assert
    expect(prisma.productImage.delete).toHaveBeenCalledWith({
      where: { id: 'img-2' },
    });
    expect(mockFilesService.delete).not.toHaveBeenCalled();
  });
});

describe('ProductsService - tenant-scoped create contract', () => {
  it('creates a product without tenantId in DTO input', async () => {
    const repo = makeMockRepo({
      isSkuTaken: jest.fn().mockResolvedValue(false),
      isBarcodeTaken: jest.fn().mockResolvedValue(false),
      save: jest.fn(async (p) => p),
      findById: jest.fn().mockResolvedValue(makeProduct('prod-created')),
    });

    const prisma = {
      $transaction: jest.fn().mockImplementation(async (cb: any) =>
        cb({
          product: { create: jest.fn().mockResolvedValue({}) },
          variant: { create: jest.fn() },
          lot: { create: jest.fn() },
          globalPriceList: { findMany: jest.fn().mockResolvedValue([]) },
          priceList: { create: jest.fn() },
          variantPrice: { create: jest.fn() },
          productImage: { create: jest.fn() },
        }),
      ),
      product: {
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          category: null,
          brand: null,
        }),
      },
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      variant: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      lot: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: jest.fn(),
      },
      productImage: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = createService(repo, prisma);

    await service.create({
      name: 'Sin Tenant ID',
    } as any);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

// ── Slice D — SAT catalog validation (create + update change-detection) ──

describe('ProductsService — SAT catalog validation (Slice D)', () => {
  function makeSpySatCatalog(opts: { exists?: boolean } = {}) {
    const exists = opts.exists ?? true;
    return {
      assertExists: jest.fn(async (key: string) => {
        if (!exists) {
          throw new BadRequestException({
            error: 'SAT_KEY_NOT_FOUND',
            message: `SAT key "${key}" is not in the catalog. Use GET /sat-keys?search=... to find a valid key.`,
          });
        }
      }),
      search: jest.fn(),
      findByKey: jest.fn(),
    } as any;
  }

  function makeProductWithSatKey(satKey: string | null) {
    return Product.fromPersistence({
      ...makePersistenceProduct({ id: PRODUCT_ID }),
      satKey,
    });
  }

  // ── CREATE path ──

  describe('create() — satKey validation (D.2)', () => {
    function setupCreateMocks() {
      const tx = {
        product: {
          create: jest.fn().mockResolvedValue({ id: PRODUCT_ID }),
        },
        variant: { create: jest.fn() },
        lot: { create: jest.fn() },
        globalPriceList: { findMany: jest.fn().mockResolvedValue([]) },
        priceList: { createMany: jest.fn(), create: jest.fn() },
        variantPrice: { createMany: jest.fn(), create: jest.fn() },
        productImage: { createMany: jest.fn(), create: jest.fn() },
      };
      const prisma = {
        $transaction: jest.fn(async (cb: any) => cb(tx)),
      } as any;
      const repo = makeMockRepo();
      return { repo, prisma };
    }

    it('accepts a satKey that exists in the catalog (D.2.1)', async () => {
      const { repo, prisma } = setupCreateMocks();
      const satCatalog = makeSpySatCatalog({ exists: true });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.create({ name: 'P1', satKey: '01010101' } as any);

      expect(satCatalog.assertExists).toHaveBeenCalledWith('01010101');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('rejects with 400 SAT_KEY_NOT_FOUND when satKey is not in the catalog (D.2.1)', async () => {
      const { repo, prisma } = setupCreateMocks();
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);

      await expect(
        service.create({ name: 'P1', satKey: '99999999' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Re-do to capture the response shape (the rejection was consumed above)
      await expect(
        service.create({ name: 'P1', satKey: '99999999' } as any),
      ).rejects.toMatchObject({
        response: { error: 'SAT_KEY_NOT_FOUND' },
      });

      expect(satCatalog.assertExists).toHaveBeenCalledWith('99999999');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('succeeds with satKey=null and skips catalog lookup when the field is omitted (D.2.1)', async () => {
      const { repo, prisma } = setupCreateMocks();
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.create({ name: 'P1' } as any);

      expect(satCatalog.assertExists).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── UPDATE path — change-detection (validate-only-on-change) ──

  describe('update() — satKey change-detection (D.3)', () => {
    function setupUpdateMocks(opts: { product?: Product } = {}) {
      const product = opts.product ?? makeProduct();
      const repo = makeMockRepo({
        findById: jest.fn().mockResolvedValue(product),
        save: jest.fn(async (p: any) => p),
      });
      const prisma = makeMockPrisma();
      return { repo, prisma, product };
    }

    it('does NOT call assertExists when satKey === current value (legacy key unchanged, D.3.1)', async () => {
      const legacyProduct = makeProductWithSatKey('LEGACY_NOT_IN_CATALOG');
      const { repo, prisma } = setupUpdateMocks({ product: legacyProduct });
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.update(PRODUCT_ID, { satKey: 'LEGACY_NOT_IN_CATALOG' });

      expect(satCatalog.assertExists).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
      const savedEntity = repo.save.mock.calls[0][0];
      expect(savedEntity.satKey).toBe('LEGACY_NOT_IN_CATALOG');
    });

    it('does NOT call assertExists when satKey is not in dto (other-field edits, D.3.2)', async () => {
      const legacyProduct = makeProductWithSatKey('LEGACY_NOT_IN_CATALOG');
      const { repo, prisma } = setupUpdateMocks({ product: legacyProduct });
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.update(PRODUCT_ID, { name: 'Nuevo' });

      expect(satCatalog.assertExists).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
      const savedEntity = repo.save.mock.calls[0][0];
      expect(savedEntity.satKey).toBe('LEGACY_NOT_IN_CATALOG');
    });

    it('rejects with 400 SAT_KEY_NOT_FOUND when satKey changes to an unknown key (D.3.3)', async () => {
      const existingProduct = makeProductWithSatKey('01010101');
      const { repo, prisma } = setupUpdateMocks({ product: existingProduct });
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);

      await expect(
        service.update(PRODUCT_ID, { satKey: '99999999' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(satCatalog.assertExists).toHaveBeenCalledWith('99999999');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('accepts and persists a satKey change to a valid known key (D.3.3)', async () => {
      const existingProduct = makeProductWithSatKey('01010101');
      const { repo, prisma } = setupUpdateMocks({ product: existingProduct });
      const satCatalog = makeSpySatCatalog({ exists: true });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.update(PRODUCT_ID, { satKey: '01010102' });

      expect(satCatalog.assertExists).toHaveBeenCalledWith('01010102');
      expect(repo.save).toHaveBeenCalled();
      const savedEntity = repo.save.mock.calls[0][0];
      expect(savedEntity.satKey).toBe('01010102');
    });

    it('accepts clearing satKey to null without calling assertExists (next === null)', async () => {
      const existingProduct = makeProductWithSatKey('01010101');
      const { repo, prisma } = setupUpdateMocks({ product: existingProduct });
      const satCatalog = makeSpySatCatalog({ exists: false });
      const service = createService(repo, prisma, undefined, satCatalog);
      jest
        .spyOn(service as any, 'buildFullResponse')
        .mockResolvedValue({ id: PRODUCT_ID });

      await service.update(PRODUCT_ID, { satKey: null } as any);

      expect(satCatalog.assertExists).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
      const savedEntity = repo.save.mock.calls[0][0];
      expect(savedEntity.satKey).toBeNull();
    });
  });
});

// ── Edit-path re-arm (low-stock-rearm-on-edit) ─────────────────────────
//
// Service wraps the persistence tail in tenantPrisma.runInTransaction so
// priceList + product + variant (useStock-off cascade) + rearm commit
// atomically. Validation stays OUTSIDE the wrap. The change-gate
// (`dto.quantity !== undefined || dto.minQuantity !== undefined`) drives
// whether `rearmAlertAfterEdit` fires.

describe('ProductsService — update() edit-path re-arm', () => {
  function makePersistenceProductWithStock(
    overrides: Partial<{
      id: string;
      useStock: boolean;
      quantity: number;
      minQuantity: number;
      previousUseStock: boolean;
    }> = {},
  ) {
    const now = new Date('2026-04-01T10:00:00.000Z');
    return {
      id: overrides.id ?? PRODUCT_ID,
      name: 'Stocked Product',
      location: null,
      description: null,
      type: 'PRODUCT',
      sku: 'SKU-1',
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
      useStock: overrides.useStock ?? true,
      useLotsAndExpirations: false,
      quantity: overrides.quantity ?? 5,
      minQuantity: overrides.minQuantity ?? 3,
      hasVariants: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * W-1 helper: construct a service backed by a REAL
   * `PrismaProductRepository` with a mocked `IStockAlertStateRepository`
   * seam. The previous W-1 assertion `(repo as any).seedAndFlip).toBeUndefined()`
   * was tautological because `IProductRepository` never exposes
   * `seedAndFlip` — that method lives on `IStockAlertStateRepository`,
   * which is consumed by the adapter. Only by wiring the real adapter
   * do we expose the `alertStateMock.seedAndFlip` method to the
   * production code path. If the edit path ever routed through
   * `alertState.seedAndFlip`, the mock would record the call and the
   * load-bearing assertion would FAIL.
   *
   * The mocked `$queryRaw` returns `[{q:10, m:3}]` so the adapter's
   * STRICT `>` gate fires (q > m) and `rearmAlertAfterEdit` actually
   * calls `alertState.rearm`. The W-1 assertion is `seedAndFlip not
   * called`; the rearm call count is a sanity check that the wiring
   * is real.
   */
  function setupServiceWithRealAdapter(opts: {
    product?: ReturnType<typeof makePersistenceProductWithStock>;
  } = {}) {
    const product = Product.fromPersistence(
      opts.product ?? makePersistenceProductWithStock(),
    );

    const alertStateMock: jest.Mocked<IStockAlertStateRepository> = {
      seedAndFlip: jest.fn().mockResolvedValue(undefined),
      rearm: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Tx client. $queryRaw returns q>m so the adapter's STRICT >
    // gate fires (q=10 > m=3) → rearm is exercised when
    // rearmAlertAfterEdit is called. product.upsert is stubbed for
    // the service's save call (the real adapter's save goes through
    // prisma.product.upsert).
    const txMock: any = {
      product: {
        findUnique: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve({
            id: where?.id ?? PRODUCT_ID,
            tenantId: 'tenant-1',
            useStock: true,
          }),
        ),
        upsert: jest.fn().mockImplementation(({ create, update }: any) =>
          Promise.resolve({
            id: update?.id ?? create?.id ?? PRODUCT_ID,
            ...create,
            ...update,
          }),
        ),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ q: 10, m: 3 }]),
    };

    const tenantPrisma = {
      getClient: jest.fn().mockReturnValue(txMock),
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      // Ambient-tx guard: rearmAlertAfterEdit throws unless
      // isInTransaction() returns true. The real adapter checks this
      // BEFORE touching the client.
      isInTransaction: jest.fn().mockReturnValue(true),
      runInTransaction: jest.fn(
        async (work: (client: typeof txMock) => Promise<unknown>) =>
          work(txMock),
      ),
    };

    const outbox = { publish: jest.fn().mockResolvedValue(undefined) };

    const realRepo = new PrismaProductRepository(
      tenantPrisma as any,
      outbox as any,
      alertStateMock,
    );

    const prisma = {
      globalPriceList: {
        findFirst: jest.fn().mockResolvedValue({ id: 'gl-publico' }),
      },
      priceList: { updateMany: jest.fn() },
      variant: { updateMany: jest.fn() },
    } as any;

    const service = createService(realRepo as any, prisma);
    (service as any).tenantPrisma = tenantPrisma;

    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    return {
      service,
      realRepo,
      tenantPrisma,
      prisma,
      product,
      alertStateMock,
    };
  }

  function setupService(opts: {
    product?: ReturnType<typeof makePersistenceProductWithStock>;
  } = {}) {
    const product = Product.fromPersistence(
      opts.product ?? makePersistenceProductWithStock(),
    );

    // ── W-2 containment proof ─────────────────────────────────────────
    // The runInTransaction wrap toggles `insideTx` while the callback
    // runs; tx-client writes + the repo's `save`/`rearmAlertAfterEdit`
    // mocks capture the flag at call time so the test can prove every
    // write happened INSIDE the wrap (not just AFTER it).
    const txState = { insideTx: false };
    const txCaptures: Array<{ method: string; insideTx: boolean }> = [];
    const recordCall = (method: string) => {
      txCaptures.push({ method, insideTx: txState.insideTx });
    };

    const repo = makeMockRepo({
      findById: jest.fn().mockResolvedValue(product),
      save: jest.fn(async (p: any) => {
        recordCall('repo.save');
        return p;
      }),
      rearmAlertAfterEdit: jest.fn(async () => {
        recordCall('repo.rearmAlertAfterEdit');
        return undefined;
      }),
    });

    // tenantPrisma exposes runInTransaction (the wrap the service must
    // use) and isInTransaction. We use a "tx client" object that
    // captures the writes routed through it (priceList, variant,
    // save's underlying upsert).
    const txClient = {
      priceList: {
        updateMany: jest.fn().mockImplementation(() => {
          recordCall('txClient.priceList.updateMany');
          return Promise.resolve({ count: 1 });
        }),
      },
      variant: {
        updateMany: jest.fn().mockImplementation(() => {
          recordCall('txClient.variant.updateMany');
          return Promise.resolve({ count: 0 });
        }),
      },
    };
    const tenantPrisma = {
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      getClient: jest.fn().mockReturnValue(txClient),
      isInTransaction: jest.fn().mockReturnValue(false),
      runInTransaction: jest.fn(
        async (work: (client: typeof txClient) => Promise<unknown>) => {
          txState.insideTx = true;
          try {
            return await work(txClient);
          } finally {
            txState.insideTx = false;
          }
        },
      ),
    };
    const prisma = {
      globalPriceList: {
        findFirst: jest.fn().mockResolvedValue({ id: 'gl-publico' }),
      },
      // raw prisma fallbacks must NOT be called inside the wrap.
      priceList: { updateMany: jest.fn() },
      variant: { updateMany: jest.fn() },
    } as any;

    const service = createService(repo, prisma);
    // Inject the real tenantPrisma (createService builds its own).
    (service as any).tenantPrisma = tenantPrisma;

    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    return {
      service,
      repo,
      tenantPrisma,
      txClient,
      prisma,
      product,
      txCaptures,
    };
  }

  it('wraps save + rearm in ONE runInTransaction when quantity is provided — Sc.1', async () => {
    const { service, repo, tenantPrisma, txClient, prisma, txCaptures } =
      setupService();

    await service.update(PRODUCT_ID, { quantity: 10 });

    // Single runInTransaction wrap.
    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    // priceList UPDATE is conditional on dto.priceCents and was not
    // provided → no call (raw OR tx).
    expect(txClient.priceList.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceList.updateMany).not.toHaveBeenCalled();
    // save was called and lives inside the wrap.
    expect(repo.save).toHaveBeenCalled();
    // rearmAlertAfterEdit was called with the simple-product key.
    expect(repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      variantId: null,
    });

    // ── W-2 containment proof: every write happened INSIDE the wrap ──
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('repo.save').length).toBeGreaterThan(0);
    expect(calls('repo.save').every((c) => c.insideTx)).toBe(true);
    expect(calls('repo.rearmAlertAfterEdit').length).toBeGreaterThan(0);
    expect(
      calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx),
    ).toBe(true);
  });

  it('routes priceList through the tx client when priceCents is in the DTO', async () => {
    const { service, tenantPrisma, txClient, prisma, txCaptures } =
      setupService();

    await service.update(PRODUCT_ID, { priceCents: 50000, quantity: 10 });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    // priceList UPDATE was routed through the tx client, not the raw
    // prisma.
    expect(txClient.priceList.updateMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID, globalPriceListId: 'gl-publico' },
      data: { priceCents: 50000 },
    });
    // raw prisma.priceList was NOT called.
    expect(prisma.priceList.updateMany).not.toHaveBeenCalled();

    // ── W-2 containment proof: priceList write + save + rearm all
    //    observed with insideTx=true. If any of them moved outside the
    //    callback (e.g. after `await runInTransaction(...)` resolved),
    //    the wrap toggle would already be back to false and the
    //    captures would record insideTx=false — failing this assertion.
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.priceList.updateMany').length).toBe(1);
    expect(
      calls('txClient.priceList.updateMany').every((c) => c.insideTx),
    ).toBe(true);
    expect(calls('repo.save').every((c) => c.insideTx)).toBe(true);
    expect(calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx)).toBe(
      true,
    );
  });

  it('wraps in runInTransaction when ONLY minQuantity is provided (RESULTING pair) — Sc.3', async () => {
    const { service, repo, tenantPrisma, txClient, txCaptures } =
      setupService();

    await service.update(PRODUCT_ID, { minQuantity: 1 });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    expect(txClient.priceList.updateMany).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalled();
    expect(repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      variantId: null,
    });

    // ── W-2 containment proof ──
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('repo.save').every((c) => c.insideTx)).toBe(true);
    expect(calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx)).toBe(
      true,
    );
  });

  it('does NOT call rearmAlertAfterEdit when neither quantity nor minQuantity is in the DTO — Sc.4', async () => {
    const { service, repo, tenantPrisma, txCaptures } = setupService();

    await service.update(PRODUCT_ID, { name: 'New name' });

    // runInTransaction still wraps the persistence tail (priceList is
    // conditional and absent here) — the wrap is what makes the
    // persistence atomic. The rearm call MUST be skipped.
    expect(repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
    // save ran.
    expect(repo.save).toHaveBeenCalled();
    // Wrap still ran exactly once (persistence is atomic).
    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);

    // ── W-2 containment proof: save happened inside the wrap; rearm
    //    was correctly gated out (and therefore not called at all).
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('repo.save').length).toBeGreaterThan(0);
    expect(calls('repo.save').every((c) => c.insideTx)).toBe(true);
    expect(calls('repo.rearmAlertAfterEdit').length).toBe(0);
  });

  it('edit path NEVER calls seedAndFlip on the alertState seam; rearm fires only on upward crossings — Sc.5', async () => {
    // Spec scenario 5: a manual downward edit lands stock <= min.
    // The edit path MUST NOT seed a new StockAlertState row and
    // MUST NOT call seedAndFlip; it only flips a possibly-existing
    // alerted row back to false (rearm). We assert that rearm is
    // called (the adapter is the q>m gate — the service's job is
    // to call it on qty/min change) and that no other alerting
    // primitive runs. The previous assertion
    // `(repo as any).seedAndFlip).toBeUndefined()` was tautological:
    // IProductRepository NEVER exposes seedAndFlip (it lives on
    // IStockAlertStateRepository). Wiring a real
    // PrismaProductRepository with a mocked alertState makes the
    // assertion load-bearing — if the production code ever routed
    // the edit path through seedAndFlip (e.g. by mistake or
    // regression), the mock would record the call and the test
    // would fail.
    const { service, alertStateMock, realRepo } = setupServiceWithRealAdapter();
    const rearmSpy = jest.spyOn(realRepo, 'rearmAlertAfterEdit');

    // Downward edit (would falsely fire on the old path) — the
    // service still calls the adapter (its job is qty/min
    // change-detection); the adapter's STRICT > gate decides.
    await service.update(PRODUCT_ID, { quantity: 1, minQuantity: 10 });
    // Upward edit (the happy path) — rearm is the only alert
    // primitive.
    await service.update(PRODUCT_ID, { quantity: 10, minQuantity: 3 });
    // Field-only edit.
    await service.update(PRODUCT_ID, { name: 'X' });

    // rearmAlertAfterEdit fires on the two edits that carried
    // quantity/minQuantity — never on the name-only edit. We spy on
    // the real adapter's method (not the mock) so the assertion still
    // pins the service-level contract.
    expect(rearmSpy).toHaveBeenCalledTimes(2);
    // Load-bearing W-1 assertion: the edit path MUST NEVER seed a new
    // StockAlertState row (seedAndFlip is the charge-time primitive;
    // rearmAlertAfterEdit is the only edit-path primitive). The
    // alertStateMock is wired through the real PrismaProductRepository,
    // so any production code path that called alertState.seedAndFlip
    // (directly, or by routing the edit through decrementStockForCharge
    // semantics) would be observed here and FAIL this test.
    expect(alertStateMock.seedAndFlip).not.toHaveBeenCalled();
    // Rearm did fire on the qty/min edits — the production adapter's
    // STRICT `>` gate decides (q=10 > m=3 ⇒ rearm). This is a
    // sanity check that the wiring is real (the spy + alertState
    // mock ARE reachable from the production code path).
    expect(alertStateMock.rearm).toHaveBeenCalled();
  });

  it('routes the useStock-false cascade variant.updateMany through the tx client — atomic with save + rearm', async () => {
    // Transition useStock true → false: the variant cascade
    // (minQuantity:0) MUST join the same tx as save and rearm so a
    // rollback does not leave a half-cascaded product behind.
    const { service, tenantPrisma, txClient, repo, txCaptures } = setupService({
      product: makePersistenceProductWithStock({
        useStock: true,
        previousUseStock: true, // matches persisted value → transition triggers
        quantity: 5,
        minQuantity: 3,
      }),
    });
    // We need previousUseStock !== false to trigger the cascade. The
    // service captures it from the persisted product; override the
    // product's useStock to true (already) and the dto to false to
    // force the transition.
    await service.update(PRODUCT_ID, { useStock: false });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    // variant cascade was routed through the tx client.
    expect(txClient.variant.updateMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
      data: { minQuantity: 0 },
    });
    // raw prisma.variant was NOT used for the cascade.
    expect((service as any).prisma.variant.updateMany).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalled();

    // ── W-2 containment proof: variant cascade + save happened
    //    INSIDE the wrap. A regression that moved the cascade outside
    //    runInTransaction (but still used getClient()) would be caught
    //    here.
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.variant.updateMany').length).toBe(1);
    expect(
      calls('txClient.variant.updateMany').every((c) => c.insideTx),
    ).toBe(true);
    expect(calls('repo.save').every((c) => c.insideTx)).toBe(true);
  });
});

describe('ProductsService — updateVariant() edit-path re-arm', () => {
  function setupService(opts: {
    product?: { useStock: boolean; quantity?: number; minQuantity?: number };
    variantRow?: any;
  } = {}) {
    const productRow = opts.product ?? { useStock: true, quantity: 5, minQuantity: 3 };
    const variantRow = opts.variantRow ?? {
      id: VARIANT_A_ID,
      productId: PRODUCT_ID,
      name: 'Red',
      option: null,
      value: null,
      sku: 'SKU-RED',
      barcode: null,
      quantity: 3,
      minQuantity: 3,
      purchaseNetCostCents: null,
      product: { useStock: productRow.useStock },
    };

    // ── W-2 containment proof ─────────────────────────────────────────────
    // runInTransaction toggles `insideTx` while the callback runs;
    // txClient writes + repo.rearmAlertAfterEdit capture the flag at
    // call time so the test can prove the writes happened INSIDE the
    // wrap (not just AFTER it). Same pattern as the update() suite.
    const txState = { insideTx: false };
    const txCaptures: Array<{ method: string; insideTx: boolean }> = [];
    const recordCall = (method: string) => {
      txCaptures.push({ method, insideTx: txState.insideTx });
    };

    const repo = makeMockRepo({
      rearmAlertAfterEdit: jest.fn(async () => {
        recordCall('repo.rearmAlertAfterEdit');
        return undefined;
      }),
    });

    const txClient = {
      variant: {
        update: jest.fn().mockImplementation((args: any) => {
          recordCall('txClient.variant.update');
          return Promise.resolve({
            ...variantRow,
            quantity: args.data?.quantity ?? variantRow.quantity,
            minQuantity: args.data?.minQuantity ?? variantRow.minQuantity,
            purchaseNetCostCents:
              args.data?.purchaseNetCostCents ??
              variantRow.purchaseNetCostCents,
          });
        }),
      },
    };
    const tenantPrisma = {
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      getClient: jest.fn().mockReturnValue(txClient),
      isInTransaction: jest.fn().mockReturnValue(false),
      runInTransaction: jest.fn(
        async (work: (client: typeof txClient) => Promise<unknown>) => {
          txState.insideTx = true;
          try {
            return await work(txClient);
          } finally {
            txState.insideTx = false;
          }
        },
      ),
    };
    const prisma = {
      variant: {
        findFirst: jest.fn().mockResolvedValue(variantRow),
        // Raw prisma.variant.update MUST NOT be called after the
        // wrap is in place — the service routes through the tx
        // client. In the RED state the service still calls the
        // raw prisma; we mock it to return a resolvable promise
        // so the existing `.then(...)` chain does not throw, and
        // our assertion that the raw call is NOT made is the
        // load-bearing check.
        update: jest
          .fn()
          .mockResolvedValue(variantRow),
      },
    } as any;

    const service = createService(repo, prisma);
    (service as any).tenantPrisma = tenantPrisma;

    return { service, repo, tenantPrisma, txClient, prisma, txCaptures };
  }

  it('wraps variant.update + rearm in ONE runInTransaction when quantity is provided — Sc.2', async () => {
    const { service, repo, tenantPrisma, txClient, prisma, txCaptures } =
      setupService();

    const updated = await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, {
      quantity: 10,
    });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    // variant.update was routed through the tx client.
    expect(txClient.variant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VARIANT_A_ID },
        data: expect.objectContaining({ quantity: 10 }),
      }),
    );
    // raw prisma.variant.update was NOT called.
    expect(prisma.variant.update).not.toHaveBeenCalled();
    // rearm was called with the variantId key.
    expect(repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      variantId: VARIANT_A_ID,
    });
    // The .then(enrichVariantCostResponse) chain still produced a
    // response object.
    expect(updated).toBeDefined();

    // ── W-2 containment proof: variant.update + rearm both observed
    //    with insideTx=true. If either moved outside the wrap (but
    //    still used getClient()), the toggle would be false and the
    //    captures would fail.
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.variant.update').length).toBeGreaterThan(0);
    expect(calls('txClient.variant.update').every((c) => c.insideTx)).toBe(
      true,
    );
    expect(
      calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx),
    ).toBe(true);
  });

  it('does NOT call rearmAlertAfterEdit when neither quantity nor minQuantity is in the DTO', async () => {
    const { service, repo, tenantPrisma, txClient, txCaptures } =
      setupService();

    await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { name: 'New' });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    expect(txClient.variant.update).toHaveBeenCalled();
    expect(repo.rearmAlertAfterEdit).not.toHaveBeenCalled();

    // ── W-2 containment proof: variant.update happened inside the
    //    wrap; rearm was correctly gated out (and therefore not called).
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.variant.update').length).toBeGreaterThan(0);
    expect(calls('txClient.variant.update').every((c) => c.insideTx)).toBe(
      true,
    );
    expect(calls('repo.rearmAlertAfterEdit').length).toBe(0);
  });

  it('wraps in runInTransaction when ONLY minQuantity is provided (RESULTING pair)', async () => {
    const { service, repo, tenantPrisma, txClient, txCaptures } =
      setupService();

    await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { minQuantity: 1 });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    expect(txClient.variant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minQuantity: 1 }),
      }),
    );
    expect(repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      variantId: VARIANT_A_ID,
    });

    // ── W-2 containment proof ──
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.variant.update').every((c) => c.insideTx)).toBe(
      true,
    );
    expect(
      calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx),
    ).toBe(true);
  });

  it('on parent useStock=false, the service still issues the wrap (adapter handles the useStock gate) — Sc.8', async () => {
    // The service's job is qty/min change-detection + atomic wrap.
    // The adapter's job is the STRICT > with useStock JOIN gate. The
    // service calls the adapter when qty/min changes; whether the
    // adapter actually fires `rearm` is the adapter spec's concern
    // (see prisma-product.repository.spec.ts Sc.8 — JOIN returns 0
    // rows on a useStock=false parent). Here we only assert the
    // service contract: wrap still runs, adapter is invoked.
    const { service, repo, tenantPrisma, txCaptures } = setupService({
      product: { useStock: false, quantity: 0, minQuantity: 0 },
    });

    await service.updateVariant(PRODUCT_ID, VARIANT_A_ID, { quantity: 5 });

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    expect(repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      variantId: VARIANT_A_ID,
    });

    // ── W-2 containment proof: variant.update + rearm both observed
    //    with insideTx=true on the wrap path.
    const calls = (method: string) =>
      txCaptures.filter((c) => c.method === method);
    expect(calls('txClient.variant.update').length).toBeGreaterThan(0);
    expect(calls('txClient.variant.update').every((c) => c.insideTx)).toBe(
      true,
    );
    expect(
      calls('repo.rearmAlertAfterEdit').every((c) => c.insideTx),
    ).toBe(true);
  });
});
