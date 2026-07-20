/**
 * ProductsService.resolveProductCategoryBrandIds — RED unit tests (W3).
 *
 * Clone of resolve-price-list-global-ids.spec.ts adapted for the new
 * resolver. Contract:
 *  - Tenant-scoped (this.tenantPrisma.getClient().product.findMany,
 *    NOT the global prisma) — Product has tenantId.
 *  - distinct ids → ONE findMany call (N+1-safe).
 *  - empty input → zero DB calls, returns an empty Map.
 *  - missing ids are silently omitted from the result map.
 *  - null categoryId/brandId on the row are PRESERVED in the map
 *    (a product may have no category, but the resolver must NOT
 *    silently drop the row — the engine relies on `null` to decide
 *    "no CATEGORIES/BRANDS match" via the null guard).
 *  - Result map: Map<productId, { categoryId: string|null, brandId: string|null }>.
 *
 * Caller: SalesService.buildPosEvalInput (W4). The resolver is
 * invoked once per recompute with the DISTINCT productIds from the
 * current draft items. Per-line stamping reads the map.
 *
 * Predecessor invariant: this resolver is structurally identical to
 * resolvePriceListGlobalIds — same tenant-scoped pattern, same N+1
 * guard. The only differences are the SELECT projection
 * (`{id, categoryId, brandId}`) and the per-row shape
 * ({categoryId, brandId}).
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';

function makeMockRepo(): jest.Mocked<IProductRepository> {
  return {
    findById: jest.fn(),
    findBySku: jest.fn(),
    findByBarcode: jest.fn(),
    findAll: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    decrementStockForCharge: jest.fn(),
    incrementStockForRestock: jest.fn(),
    rearmAlertAfterEdit: jest.fn().mockResolvedValue(undefined),
    isSkuTaken: jest.fn().mockResolvedValue(false),
    isBarcodeTaken: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<IProductRepository>;
}

function makeMockPrisma() {
  return {
    product: {
      findMany: jest.fn(),
    },
  } as any;
}

function makeService(prisma: ReturnType<typeof makeMockPrisma>) {
  const repo = makeMockRepo();
  const tenantPrisma = {
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
    isInTransaction: jest.fn().mockReturnValue(false),
    runInTransaction: jest.fn(async (work: any) => work(prisma)),
  } as any;

  return {
    repo,
    prisma,
    service: new ProductsService(
      repo,
      {} as any,
      {} as any,
      tenantPrisma,
      {} as any,
    ),
  };
}

describe('ProductsService.resolveProductCategoryBrandIds', () => {
  it('returns an empty Map and makes NO DB call when given an empty array', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;

    const map = await service.resolveProductCategoryBrandIds([]);

    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('makes exactly ONE product.findMany call regardless of how many distinct ids are passed (N+1-safe)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P1', categoryId: 'CAT1', brandId: 'BR1' },
      { id: 'P2', categoryId: 'CAT2', brandId: null },
    ]);

    const map = await service.resolveProductCategoryBrandIds([
      'P1',
      'P2',
      'P3',
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    // Should be called on the tenant-scoped client (NOT the global prisma).
    const args = findMany.mock.calls[0][0];
    expect(args.where.id.in).toEqual(['P1', 'P2', 'P3']);
    // The projection selects only what the engine needs (id +
    // categoryId + brandId). Nothing more.
    expect(args.select).toEqual({
      id: true,
      categoryId: true,
      brandId: true,
    });
    expect(map.size).toBe(2);
  });

  it('returns a Map keyed by productId whose value is { categoryId, brandId } (both possibly null)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P1', categoryId: 'CAT1', brandId: 'BR1' },
      { id: 'P2', categoryId: null, brandId: 'BR2' },
      { id: 'P3', categoryId: 'CAT3', brandId: null },
    ]);

    const map = await service.resolveProductCategoryBrandIds([
      'P1',
      'P2',
      'P3',
    ]);

    expect(map.get('P1')).toEqual({ categoryId: 'CAT1', brandId: 'BR1' });
    expect(map.get('P2')).toEqual({ categoryId: null, brandId: 'BR2' });
    expect(map.get('P3')).toEqual({ categoryId: 'CAT3', brandId: null });
  });

  it('preserves null categoryId/brandId on the row (does NOT silently drop rows with either field null)', async () => {
    // A product with BOTH fields null is still a row the caller
    // cares about (it's in the cart). The resolver MUST keep it so
    // the engine can stamp `categoryId: null, brandId: null` and
    // the null-guard at matchTargetTier correctly returns null for
    // any CATEGORIES/BRANDS promotion on that line.
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P-NULL', categoryId: null, brandId: null },
    ]);

    const map = await service.resolveProductCategoryBrandIds(['P-NULL']);

    expect(map.size).toBe(1);
    expect(map.get('P-NULL')).toEqual({ categoryId: null, brandId: null });
  });

  it('silently omits ids the DB did not return (no error, no entry in Map)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P1', categoryId: 'CAT1', brandId: 'BR1' },
    ]);

    const map = await service.resolveProductCategoryBrandIds([
      'P1',
      'P-MISSING',
    ]);

    expect(map.size).toBe(1);
    expect(map.get('P1')).toEqual({ categoryId: 'CAT1', brandId: 'BR1' });
    expect(map.has('P-MISSING')).toBe(false);
  });

  it('deduplicates ids before querying (N+1-safe with duplicates in input)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P1', categoryId: 'CAT1', brandId: 'BR1' },
    ]);

    const map = await service.resolveProductCategoryBrandIds([
      'P1',
      'P1',
      'P1',
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(['P1']);
    expect(map.size).toBe(1);
  });

  it('routes the read through the tenant prisma client (tenant isolation)', async () => {
    // If the implementation were to call `this.prisma.product.findMany`,
    // tenant scope would be lost. We assert the tenant getClient was used.
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.product.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'P1', categoryId: 'CAT1', brandId: 'BR1' },
    ]);

    // Make the underlying "global prisma" carry a findMany that
    // would be called if the implementation mistakenly bypassed
    // tenant scoping.
    const globalPrisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    (service as any).prisma = globalPrisma;

    await service.resolveProductCategoryBrandIds(['P1']);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(globalPrisma.product.findMany).not.toHaveBeenCalled();
  });
});
