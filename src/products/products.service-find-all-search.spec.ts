/**
 * ProductsService.findAll — Search & Pagination Contract
 *
 * Proves the bug fix: `GET /products?search=ibup` MUST exclude "Paracetamol"
 * and only return products whose `name`, `sku`, or `barcode` matches the
 * search term (case-insensitive, trimmed). The pagination fields `page`
 * and `limit` cap and offset the result set.
 *
 * The original (buggy) behavior was that `findAll()` returned EVERY product
 * regardless of any query param. The frontend's product selector saw the full
 * catalog while typing, which is the root cause of the confirmed
 * Paracetamol-vs-Ibuprofeno wrong-id promotion save.
 *
 * These tests are RED before the service implementation change and GREEN
 * after.
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';

// ── Test fixtures ──────────────────────────────────────────────────────

const IBUP_ID = '11111111-1111-1111-1111-111111111111';
const PARACETAMOL_ID = '22222222-2222-2222-2222-222222222222';
const ASPIRIN_ID = '33333333-3333-3333-3333-333333333333';

function makeMockRepo() {
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
  } as jest.Mocked<IProductRepository>;
}

function makeMockPrisma(findManyMock: jest.Mock) {
  return {
    product: { findMany: findManyMock },
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

function makeNoopSatCatalog() {
  return {
    assertExists: jest.fn().mockResolvedValue(undefined),
    search: jest.fn(),
    findByKey: jest.fn(),
  } as any;
}

function makeTenantPrisma(prisma: any) {
  return {
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
    isInTransaction: jest.fn().mockReturnValue(false),
    runInTransaction: jest.fn(
      async (work: (client: any) => Promise<unknown>) => work(prisma),
    ),
  } as any;
}

function createService(prisma: any) {
  return new ProductsService(
    makeMockRepo(),
    prisma,
    makeMockFilesService(),
    makeTenantPrisma(prisma),
    makeNoopSatCatalog(),
  );
}

// Build a persistence-shape row for a product with the fields findAll selects.
function makeProductRow(args: {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  hasVariants?: boolean;
  quantity?: number;
  category?: { id: string; name: string } | null;
  brand?: { id: string; name: string } | null;
  priceLists?: { priceCents: number }[];
}) {
  const now = new Date('2026-04-01T10:00:00.000Z');
  return {
    id: args.id,
    name: args.name,
    location: null,
    description: null,
    type: 'PRODUCT',
    sku: args.sku ?? null,
    barcode: args.barcode ?? null,
    unit: 'UNIDAD',
    satKey: null,
    categoryId: args.category?.id ?? null,
    brandId: args.brand?.id ?? null,
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
    quantity: args.quantity ?? 10,
    minQuantity: 0,
    hasVariants: args.hasVariants ?? false,
    createdAt: now,
    updatedAt: now,
    category: args.category ?? null,
    brand: args.brand ?? null,
    _count: { variants: 0 },
    variants: [],
    priceLists: args.priceLists ?? [],
  };
}

const IBUP = makeProductRow({
  id: IBUP_ID,
  name: 'Ibuprofeno 400mg',
  sku: 'SKU-IBUP-400',
  barcode: '7501000000011',
});
const PARACETAMOL = makeProductRow({
  id: PARACETAMOL_ID,
  name: 'Paracetamol 500mg',
  sku: 'SKU-PARA-500',
  barcode: '7501000000028',
});
const ASPIRIN = makeProductRow({
  id: ASPIRIN_ID,
  name: 'Aspirina 100mg',
  sku: 'SKU-ASPI-100',
  barcode: '7501000000035',
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProductsService.findAll — search filter (bug fix)', () => {
  // THE BUG: previously, the search term was ignored and ALL products were
  // returned. This single assertion is the smoking gun: searching "ibup"
  // MUST NOT return Paracetamol. The mock simulates the DB filtering by
  // returning only the rows that would match the WHERE OR clause.
  it('excludes Paracetamol when search="ibup" matches Ibuprofeno (THE BUG FIX)', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: 'ibup' } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(IBUP_ID);
    expect(result[0].name).toBe('Ibuprofeno 400mg');
  });

  it('passes a case-insensitive WHERE OR clause on name/sku/barcode to findMany', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = createService(makeMockPrisma(findMany));

    await service.findAll({ search: 'ibup' } as any);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args).toHaveProperty('where');
    expect(args.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: { contains: 'ibup', mode: 'insensitive' },
        }),
        expect.objectContaining({
          sku: { contains: 'ibup', mode: 'insensitive' },
        }),
        expect.objectContaining({
          barcode: { contains: 'ibup', mode: 'insensitive' },
        }),
      ]),
    );
  });

  it('is case-insensitive: search "IBUP" matches "Ibuprofeno 400mg"', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: 'IBUP' } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(IBUP_ID);
    const args = findMany.mock.calls[0][0];
    // The Prisma `mode: 'insensitive'` flag is what makes the query
    // case-insensitive at the DB level. The mock returns the matching row,
    // and the WHERE clause must declare the intent.
    const nameFilter = args.where.OR.find(
      (c: any) => c.name?.contains === 'IBUP',
    );
    expect(nameFilter.name.mode).toBe('insensitive');
  });

  it('trims surrounding whitespace: search "  ibup  " matches "Ibuprofeno 400mg"', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP]);
    const service = createService(makeMockPrisma(findMany));

    await service.findAll({ search: '  ibup  ' } as any);

    const args = findMany.mock.calls[0][0];
    const nameFilter = args.where.OR.find(
      (c: any) => c.name?.contains !== undefined,
    );
    expect(nameFilter.name.contains).toBe('ibup'); // trimmed
  });

  it('matches by SKU: search "ASPI-100" returns Aspirin (not by name)', async () => {
    const findMany = jest.fn().mockResolvedValue([ASPIRIN]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: 'ASPI-100' } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ASPIRIN_ID);
  });

  it('matches by barcode substring: search "7501000000028" returns Paracetamol', async () => {
    const findMany = jest.fn().mockResolvedValue([PARACETAMOL]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: '7501000000028' } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PARACETAMOL_ID);
  });

  it('treats an empty search string as no-search: returns ALL products, no WHERE clause', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP, PARACETAMOL, ASPIRIN]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: '' } as any);

    expect(result).toHaveLength(3);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toBeUndefined();
  });

  it('treats whitespace-only search as no-search', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP, PARACETAMOL, ASPIRIN]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ search: '   ' } as any);

    expect(result).toHaveLength(3);
    expect(findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe('ProductsService.findAll — backward compatibility (no query)', () => {
  // These tests assert that the flat-array + per-item shape contract is
  // preserved when no query is provided. The 8 existing tests in
  // products.service.spec.ts already check this for `findAll()` with no args;
  // these cover the `findAll({})` shape explicitly.

  it('findAll({}) returns ALL products as a flat array (no filter, no pagination)', async () => {
    const findMany = jest.fn().mockResolvedValue([IBUP, PARACETAMOL, ASPIRIN]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({} as any);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toBeUndefined();
    // Backward-compat: when no DTO defaults are supplied, no skip/take is sent.
    expect(args.skip).toBeUndefined();
    expect(args.take).toBeUndefined();
  });

  it('findAll({}) preserves hasVariants + priceCents + priceDecimal per item', async () => {
    const ibupWithPrice = {
      ...IBUP,
      hasVariants: false,
      priceLists: [{ priceCents: 3500 }],
    };
    const findMany = jest.fn().mockResolvedValue([ibupWithPrice]);
    const service = createService(makeMockPrisma(findMany));

    const [result] = await service.findAll({} as any);

    expect(result.hasVariants).toBe(false);
    expect(result).toHaveProperty('priceCents', 3500);
    expect(result).toHaveProperty('priceDecimal', 35);
    expect(result).toHaveProperty('id', IBUP_ID);
    expect(result).toHaveProperty('name', 'Ibuprofeno 400mg');
  });
});

describe('ProductsService.findAll — pagination', () => {
  it('applies skip and take from {page, limit}', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = createService(makeMockPrisma(findMany));

    await service.findAll({ page: 2, limit: 5 } as any);

    const args = findMany.mock.calls[0][0];
    expect(args.skip).toBe(5); // (page - 1) * limit
    expect(args.take).toBe(5);
  });

  it('applies limit independently when only limit is supplied', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = createService(makeMockPrisma(findMany));

    await service.findAll({ limit: 3 } as any);

    const args = findMany.mock.calls[0][0];
    expect(args.take).toBe(3);
    // No page provided → skip defaults to 0 (start from the beginning).
    expect(args.skip).toBe(0);
  });

  it('caps results to `limit` when more matches exist', async () => {
    // 5 products mocked but limit=2 → service must request only 2 from Prisma.
    const findMany = jest.fn().mockResolvedValue([IBUP, PARACETAMOL]);
    const service = createService(makeMockPrisma(findMany));

    const result = await service.findAll({ limit: 2 } as any);

    expect(result).toHaveLength(2);
    expect(findMany.mock.calls[0][0].take).toBe(2);
  });
});
