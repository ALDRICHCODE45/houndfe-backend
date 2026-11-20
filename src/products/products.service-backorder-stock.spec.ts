/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access -- jest mocks of the service collaborators */
/**
 * restock-backorder / T5b — stock fields on the POS-used product reads and the
 * variant block (contract v1 §3, §9.4; frontend L2, L13).
 *
 * - `stockOnHand` = quantity + reservedForBackorders, `reservedForBackorders`
 *   = Σ RESERVED backorder quantities, `availableToSell` = today's quantity.
 * - ONE batched backorder read per response, never one per product/variant.
 * - Adding the first variant (POST /products/:id/variants) or enabling variants
 *   (PATCH /products/:id {hasVariants:true}) while a WAITING/RESERVED
 *   product-level backorder exists answers 409 PRODUCT_HAS_ACTIVE_BACKORDERS.
 */
import { ProductsService } from './products.service';
import { Product } from './domain/product.entity';
import type { IProductRepository } from './domain/product.repository';
import { makeStockJournalStub } from './infrastructure/product-stock-journal.test-support';
import { EntityAlreadyExistsError } from '../shared/domain/domain-error';

const TENANT = 'tenant-1';
const PLAIN = 'prod-plain';
const WITH_VARIANTS = 'prod-variants';
const V1 = 'variant-1';
const V2 = 'variant-2';

type ReservedRow = {
  productId: string;
  variantId: string | null;
  _sum: { quantity: number | null };
};

function makeRepo(overrides: Partial<IProductRepository> = {}) {
  return {
    findById: jest.fn(),
    save: jest.fn(),
    isSkuTaken: jest.fn().mockResolvedValue(false),
    isBarcodeTaken: jest.fn().mockResolvedValue(false),
    rearmAlertAfterEdit: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as jest.Mocked<IProductRepository>;
}

function makeService(
  prisma: Record<string, unknown>,
  repo: IProductRepository = makeRepo(),
) {
  const stockJournal = makeStockJournalStub();
  (prisma as { $executeRaw?: jest.Mock }).$executeRaw ??= jest
    .fn()
    .mockResolvedValue(0);
  const tenantPrisma = {
    getTenantId: jest.fn().mockReturnValue(TENANT),
    getClient: jest.fn().mockReturnValue(prisma),
    isInTransaction: jest.fn().mockReturnValue(false),
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  const service = new ProductsService(
    repo,
    prisma as never,
    { findById: jest.fn(), findByIds: jest.fn() } as never,
    tenantPrisma as never,
    { assertExists: jest.fn() } as never,
    stockJournal,
  );
  return { service, repo, stockJournal };
}

const groupByOf = (rows: ReservedRow[]) => jest.fn().mockResolvedValue(rows);

function productRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-04-01T10:00:00.000Z');
  return {
    id: PLAIN,
    name: 'Croquetas',
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
    quantity: 5,
    minQuantity: 0,
    hasVariants: false,
    hidePriceInOnlineCatalog: false,
    onlineStockPresentation: 'EXACT',
    onlineStockPresentationCustomQty: null,
    serviceDetail: null,
    category: null,
    brand: null,
    priceLists: [],
    variants: [],
    _count: { variants: 0 },
    catalogPriceLists: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ProductsService.findAll — stock fields (GET /products)', () => {
  it('adds stockOnHand/reservedForBackorders/availableToSell per product with ONE batched backorder read', async () => {
    const groupBy = groupByOf([
      { productId: PLAIN, variantId: null, _sum: { quantity: 2 } },
      { productId: WITH_VARIANTS, variantId: V1, _sum: { quantity: 4 } },
      { productId: WITH_VARIANTS, variantId: V2, _sum: { quantity: 2 } },
    ]);
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          productRow({ id: PLAIN, quantity: 5 }),
          productRow({
            id: WITH_VARIANTS,
            hasVariants: true,
            quantity: 0,
            variants: [{ quantity: 3 }, { quantity: 4 }],
            _count: { variants: 2 },
          }),
          productRow({ id: 'prod-none', quantity: 9 }),
        ]),
      },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    const result = await service.findAll();

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0]).toMatchObject({
      where: {
        tenantId: TENANT,
        status: 'RESERVED',
        productId: { in: [PLAIN, WITH_VARIANTS, 'prod-none'] },
      },
    });
    const [plain, withVariants, none] = result as Array<
      Record<string, unknown>
    >;
    // Plain product: today's `quantity` keeps its meaning.
    expect(plain).toMatchObject({
      quantity: 5,
      stockOnHand: 7,
      reservedForBackorders: 2,
      availableToSell: 5,
    });
    // Variant product: product level aggregates its variants (like variantStockTotal).
    expect(withVariants).toMatchObject({
      quantity: 0,
      variantStockTotal: 7,
      stockOnHand: 13,
      reservedForBackorders: 6,
      availableToSell: 7,
    });
    expect(none).toMatchObject({
      quantity: 9,
      stockOnHand: 9,
      reservedForBackorders: 0,
      availableToSell: 9,
    });
  });

  it('runs no backorder read for an empty page', async () => {
    const groupBy = groupByOf([]);
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([]) },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(service.findAll()).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('ProductsService.findOne / getVariants — stock fields', () => {
  function detailPrisma(groupBy: jest.Mock) {
    const variantRow = (id: string, quantity: number) => ({
      id,
      productId: WITH_VARIANTS,
      name: id,
      sku: null,
      barcode: null,
      quantity,
      minQuantity: 0,
      purchaseNetCostCents: null,
      createdAt: new Date('2026-04-01T10:00:00.000Z'),
      updatedAt: new Date('2026-04-01T10:00:00.000Z'),
      images: [],
      variantPrices: [],
    });
    return {
      product: { findUnique: jest.fn().mockResolvedValue(null) },
      priceList: { findMany: jest.fn().mockResolvedValue([]) },
      variant: {
        findMany: jest
          .fn()
          .mockResolvedValue([variantRow(V1, 3), variantRow(V2, 4)]),
      },
      productImage: { findMany: jest.fn().mockResolvedValue([]) },
      lot: { findMany: jest.fn().mockResolvedValue([]) },
      backorder: { groupBy },
    };
  }

  const variantProduct = () =>
    Product.create({
      id: WITH_VARIANTS,
      name: 'Camisa',
      hasVariants: true,
    });

  it('GET /products/:id: product level and every variant, from one backorder read', async () => {
    const groupBy = groupByOf([
      { productId: WITH_VARIANTS, variantId: V1, _sum: { quantity: 4 } },
    ]);
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(variantProduct()),
    });
    const { service } = makeService(detailPrisma(groupBy), repo);

    const detail = (await service.findOne(WITH_VARIANTS)) as unknown as {
      variants: Array<Record<string, unknown>>;
    } & Record<string, unknown>;

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(detail).toMatchObject({
      variantStockTotal: 7,
      stockOnHand: 11,
      reservedForBackorders: 4,
      availableToSell: 7,
    });
    expect(detail.variants[0]).toMatchObject({
      id: V1,
      quantity: 3,
      stockOnHand: 7,
      reservedForBackorders: 4,
      availableToSell: 3,
    });
    expect(detail.variants[1]).toMatchObject({
      id: V2,
      quantity: 4,
      stockOnHand: 4,
      reservedForBackorders: 0,
      availableToSell: 4,
    });
  });

  it('GET /products/:id: a product without variants reports its own quantity', async () => {
    const groupBy = groupByOf([
      { productId: PLAIN, variantId: null, _sum: { quantity: 3 } },
    ]);
    const prisma = detailPrisma(groupBy);
    const repo = makeRepo({
      findById: jest
        .fn()
        .mockResolvedValue(
          Product.create({ id: PLAIN, name: 'Croquetas', quantity: 2 }),
        ),
    });
    const { service } = makeService(prisma, repo);

    const detail = (await service.findOne(PLAIN)) as unknown as Record<
      string,
      unknown
    >;

    expect(detail).toMatchObject({
      quantity: 2,
      stockOnHand: 5,
      reservedForBackorders: 3,
      availableToSell: 2,
    });
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('GET /products/:id/variants: each variant carries the fields, ONE backorder read for all', async () => {
    const groupBy = groupByOf([
      { productId: WITH_VARIANTS, variantId: V1, _sum: { quantity: 1 } },
      { productId: WITH_VARIANTS, variantId: V2, _sum: { quantity: 6 } },
    ]);
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue(variantProduct()),
    });
    const { service } = makeService(detailPrisma(groupBy), repo);

    const variants = (await service.getVariants(WITH_VARIANTS)) as Array<
      Record<string, unknown>
    >;

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({
      quantity: 3,
      stockOnHand: 4,
      reservedForBackorders: 1,
      availableToSell: 3,
    });
    expect(variants[1]).toMatchObject({
      quantity: 4,
      stockOnHand: 10,
      reservedForBackorders: 6,
      availableToSell: 4,
    });
  });
});

describe('ProductsService POS catalog — stock fields (GET /sales/pos-catalog)', () => {
  const posProduct = (overrides: Record<string, unknown>) => ({
    id: PLAIN,
    name: 'Croquetas',
    description: null,
    sku: null,
    barcode: null,
    unit: 'UNIDAD',
    hasVariants: false,
    useStock: true,
    quantity: 5,
    minQuantity: 1,
    location: null,
    sellInPos: true,
    category: null,
    brand: null,
    images: [],
    priceLists: [],
    variants: [],
    ...overrides,
  });
  const posVariant = (id: string, quantity: number) => ({
    id,
    name: id,
    sku: null,
    barcode: null,
    quantity,
    minQuantity: 0,
    images: [],
    variantPrices: [],
  });

  it('search: product stock and variant stock carry the fields; ONE backorder read for the page', async () => {
    const groupBy = groupByOf([
      { productId: PLAIN, variantId: null, _sum: { quantity: 2 } },
      { productId: WITH_VARIANTS, variantId: V2, _sum: { quantity: 5 } },
    ]);
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          posProduct({ id: PLAIN, quantity: 5 }),
          posProduct({
            id: WITH_VARIANTS,
            hasVariants: true,
            quantity: 0,
            variants: [posVariant(V1, 3), posVariant(V2, 4)],
          }),
          posProduct({ id: 'prod-nostock', useStock: false, quantity: 0 }),
        ]),
        count: jest.fn().mockResolvedValue(3),
      },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    const result = await service.searchForPOS({});

    expect(groupBy).toHaveBeenCalledTimes(1);
    const [plain, variants, noStock] = result.items;
    expect(plain.stock).toEqual({
      quantity: 5,
      minQuantity: 1,
      location: null,
      stockOnHand: 7,
      reservedForBackorders: 2,
      availableToSell: 5,
    });
    // Product level of a variant product keeps `stock: null`; the variants carry it.
    expect(variants.stock).toBeNull();
    expect(variants.variants[0].stock).toMatchObject({
      quantity: 3,
      stockOnHand: 3,
      reservedForBackorders: 0,
      availableToSell: 3,
    });
    expect(variants.variants[1].stock).toMatchObject({
      quantity: 4,
      stockOnHand: 9,
      reservedForBackorders: 5,
      availableToSell: 4,
    });
    // Stock not tracked → no stock object, as today.
    expect(noStock.stock).toBeNull();
  });

  it('detail: GET /sales/pos-catalog/:productId carries the same fields', async () => {
    const groupBy = groupByOf([
      { productId: PLAIN, variantId: null, _sum: { quantity: 1 } },
    ]);
    const prisma = {
      product: {
        findFirst: jest
          .fn()
          .mockResolvedValue(posProduct({ id: PLAIN, quantity: 0 })),
      },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    const detail = await service.findOneForPOS(PLAIN);

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(detail?.stock).toMatchObject({
      quantity: 0,
      stockOnHand: 1,
      reservedForBackorders: 1,
      availableToSell: 0,
    });
  });

  it('detail of an unknown product runs no backorder read', async () => {
    const groupBy = groupByOf([]);
    const prisma = {
      product: { findFirst: jest.fn().mockResolvedValue(null) },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(service.findOneForPOS(PLAIN)).resolves.toBeNull();
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('ProductsService.checkStockAvailability — reserved units (add-item warning input)', () => {
  const product = (overrides: Record<string, unknown> = {}) => ({
    id: PLAIN,
    useStock: true,
    hasVariants: false,
    quantity: 2,
    ...overrides,
  });

  it('reports reservedForBackorders only when the quantity is NOT available', async () => {
    const groupBy = groupByOf([
      { productId: PLAIN, variantId: null, _sum: { quantity: 4 } },
    ]);
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue(product()) },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(
      service.checkStockAvailability(PLAIN, null, 5),
    ).resolves.toEqual({
      available: false,
      currentStock: 2,
      reservedForBackorders: 4,
    });
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('does not touch backorders when the stock covers the quantity (hot path unchanged)', async () => {
    const groupBy = groupByOf([]);
    const prisma = {
      product: { findUnique: jest.fn().mockResolvedValue(product()) },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(
      service.checkStockAvailability(PLAIN, null, 2),
    ).resolves.toEqual({ available: true, currentStock: 2 });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('variant line: reserved units of that variant only', async () => {
    const groupBy = groupByOf([
      { productId: WITH_VARIANTS, variantId: V1, _sum: { quantity: 3 } },
      { productId: WITH_VARIANTS, variantId: V2, _sum: { quantity: 9 } },
    ]);
    const prisma = {
      product: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            product({ id: WITH_VARIANTS, hasVariants: true, quantity: 0 }),
          ),
      },
      variant: { findFirst: jest.fn().mockResolvedValue({ quantity: 1 }) },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(
      service.checkStockAvailability(WITH_VARIANTS, V1, 3),
    ).resolves.toEqual({
      available: false,
      currentStock: 1,
      reservedForBackorders: 3,
    });
  });

  it('a product that does not track stock stays always available', async () => {
    const groupBy = groupByOf([]);
    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(product({ useStock: false })),
      },
      backorder: { groupBy },
    };
    const { service } = makeService(prisma);

    await expect(
      service.checkStockAvailability(PLAIN, null, 99),
    ).resolves.toEqual({ available: true, currentStock: null });
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('ProductsService — variant block (PRODUCT_HAS_ACTIVE_BACKORDERS)', () => {
  const ACTIVE = ['WAITING', 'RESERVED'];

  function variantFixture(activeBackorders: number) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: PLAIN }]),
      backorder: { count: jest.fn().mockResolvedValue(activeBackorders) },
      variant: {
        create: jest.fn().mockResolvedValue({ id: V1, name: 'Rojo' }),
      },
      priceList: { findMany: jest.fn().mockResolvedValue([]) },
      variantPrice: { createMany: jest.fn() },
      product: { update: jest.fn() },
    };
    const repo = makeRepo({
      findById: jest
        .fn()
        .mockResolvedValue(Product.create({ id: PLAIN, name: 'Croquetas' })),
    });
    const made = makeService(tx, repo);
    return { ...made, tx };
  }

  it('POST /products/:id/variants: active product-level backorders → 409, nothing written', async () => {
    const { service, tx, stockJournal } = variantFixture(2);

    const result = service.addVariant(PLAIN, { name: 'Rojo' });

    await expect(result).rejects.toBeInstanceOf(EntityAlreadyExistsError);
    await expect(result).rejects.toMatchObject({
      code: 'PRODUCT_HAS_ACTIVE_BACKORDERS',
      message: 'El producto tiene pedidos por reposición activos',
    });
    expect(tx.backorder.count).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        productId: PLAIN,
        variantId: null,
        status: { in: ACTIVE },
      },
    });
    expect(tx.variant.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(stockJournal.removeProductStock).not.toHaveBeenCalled();
  });

  it('POST /products/:id/variants: a product without active backorders still gets its variant', async () => {
    const { service, tx } = variantFixture(0);

    await service.addVariant(PLAIN, { name: 'Rojo' });

    expect(tx.variant.create).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
  });

  function patchFixture(activeBackorders: number, hasVariants = false) {
    const product = Product.create({
      id: PLAIN,
      name: 'Croquetas',
      hasVariants,
    });
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(product) });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: PLAIN }]),
      backorder: { count: jest.fn().mockResolvedValue(activeBackorders) },
      variant: { count: jest.fn().mockResolvedValue(0) },
      priceList: { updateMany: jest.fn() },
      serviceDetail: { deleteMany: jest.fn() },
    };
    const made = makeService(tx, repo);
    jest
      .spyOn(
        made.service as unknown as {
          buildFullResponse: () => Promise<unknown>;
        },
        'buildFullResponse',
      )
      .mockResolvedValue({});
    return { ...made, tx };
  }

  it('PATCH /products/:id {hasVariants:true}: active backorders → same 409 before the stock is zeroed or saved', async () => {
    const { service, repo, tx, stockJournal } = patchFixture(1);

    const result = service.update(PLAIN, { hasVariants: true });

    await expect(result).rejects.toMatchObject({
      code: 'PRODUCT_HAS_ACTIVE_BACKORDERS',
    });
    expect(tx.backorder.count).toHaveBeenCalled();
    expect(stockJournal.removeProductStock).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('PATCH /products/:id {hasVariants:true}: no active backorders → proceeds', async () => {
    const { service, repo, stockJournal } = patchFixture(0);

    await service.update(PLAIN, { hasVariants: true });

    expect(stockJournal.removeProductStock).toHaveBeenCalledWith(
      PLAIN,
      'FIRST_VARIANT_ZEROING',
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('PATCH without a hasVariants change never reads backorders', async () => {
    const { service, tx } = patchFixture(5);

    await service.update(PLAIN, { name: 'Otro nombre' });

    expect(tx.backorder.count).not.toHaveBeenCalled();
  });
});
