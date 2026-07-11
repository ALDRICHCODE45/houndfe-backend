/**
 * ProductsService.resolvePriceListGlobalIds — RED unit tests (2.7).
 *
 * Proves:
 *  - distinct ids → ONE tenant-scoped `PriceList.findMany` call (N+1-safe).
 *  - empty input → zero DB calls, returns an empty Map.
 *  - returns a Map keyed by `PriceList.id` whose value is the
 *    underlying `globalPriceListId`.
 *  - missing ids are silently omitted from the Map (no error).
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
    priceList: {
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

describe('ProductsService.resolvePriceListGlobalIds', () => {
  it('returns an empty Map and makes NO DB call when given an empty array', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;

    const map = await service.resolvePriceListGlobalIds([]);

    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('makes exactly ONE findMany call regardless of how many distinct ids are passed (N+1-safe)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'PL-a', globalPriceListId: 'GPL-retail' },
      { id: 'PL-b', globalPriceListId: 'GPL-mayoreo' },
    ]);

    const map = await service.resolvePriceListGlobalIds([
      'PL-a',
      'PL-b',
      'PL-c',
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    // Should be called on the tenant-scoped client (NOT the global prisma).
    const args = findMany.mock.calls[0][0];
    expect(args.where.id.in).toEqual(['PL-a', 'PL-b', 'PL-c']);
    expect(args.select).toEqual({ id: true, globalPriceListId: true });
    expect(map.size).toBe(2);
  });

  it('returns a Map keyed by PriceList.id whose value is the resolved globalPriceListId', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'PL-a', globalPriceListId: 'GPL-retail' },
      { id: 'PL-b', globalPriceListId: 'GPL-mayoreo' },
    ]);

    const map = await service.resolvePriceListGlobalIds(['PL-a', 'PL-b']);

    expect(map.get('PL-a')).toBe('GPL-retail');
    expect(map.get('PL-b')).toBe('GPL-mayoreo');
  });

  it('silently omits ids the DB did not return (no error, no entry in Map)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'PL-a', globalPriceListId: 'GPL-retail' },
    ]);

    const map = await service.resolvePriceListGlobalIds(['PL-a', 'PL-missing']);

    expect(map.size).toBe(1);
    expect(map.get('PL-a')).toBe('GPL-retail');
    expect(map.has('PL-missing')).toBe(false);
  });

  it('deduplicates ids before querying (N+1-safe with duplicates in input)', async () => {
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'PL-a', globalPriceListId: 'GPL-retail' },
    ]);

    const map = await service.resolvePriceListGlobalIds([
      'PL-a',
      'PL-a',
      'PL-a',
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(['PL-a']);
    expect(map.size).toBe(1);
    expect(map.get('PL-a')).toBe('GPL-retail');
  });

  it('routes the read through the tenant prisma client (tenant isolation)', async () => {
    // If the implementation were to call `this.prisma.priceList.findMany`,
    // tenant scope would be lost. We assert the tenant getClient was used.
    const { prisma, service } = makeService(makeMockPrisma());
    const findMany = prisma.priceList.findMany as jest.Mock;
    findMany.mockResolvedValue([
      { id: 'PL-x', globalPriceListId: 'GPL-retail' },
    ]);

    // Make the underlying "global prisma" carry a findMany that would be
    // called if the implementation mistakenly bypassed tenant scoping.
    const globalPrisma = {
      priceList: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    (service as any).prisma = globalPrisma;

    await service.resolvePriceListGlobalIds(['PL-x']);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(globalPrisma.priceList.findMany).not.toHaveBeenCalled();
  });
});
