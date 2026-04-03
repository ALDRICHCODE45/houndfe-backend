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

function createService(
  repo: IProductRepository,
  prisma: ReturnType<typeof makeMockPrisma>,
) {
  return new ProductsService(repo, prisma as any);
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

describe('ProductsService — findAll variant aggregates', () => {
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
        { variantId: VARIANT_A_ID, priceListId: 'pl-publico', priceCents: 0 },
        { variantId: VARIANT_A_ID, priceListId: 'pl-mayoreo', priceCents: 0 },
      ],
    });
  });

  it('should create product price lists for all global lists', async () => {
    const savedProduct = makeProduct();
    const repo = makeMockRepo({
      save: jest.fn().mockResolvedValue(savedProduct),
    });

    const prisma = {
      globalPriceList: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'gl-publico', isDefault: true },
          { id: 'gl-mayoreo', isDefault: false },
        ]),
      },
      priceList: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as any;

    const service = createService(repo, prisma);
    jest
      .spyOn(service as any, 'buildFullResponse')
      .mockResolvedValue({ id: PRODUCT_ID });

    await service.create({ name: 'Producto', priceCents: 1999 });

    expect(prisma.priceList.createMany).toHaveBeenCalledWith({
      data: [
        {
          productId: PRODUCT_ID,
          globalPriceListId: 'gl-publico',
          priceCents: 1999,
        },
        {
          productId: PRODUCT_ID,
          globalPriceListId: 'gl-mayoreo',
          priceCents: 0,
        },
      ],
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
        { variantPriceId: 'vp-1', minQuantity: 0, priceCents: 1200 },
        { variantPriceId: 'vp-1', minQuantity: 10, priceCents: 1000 },
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
