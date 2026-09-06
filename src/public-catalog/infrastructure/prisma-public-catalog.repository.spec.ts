import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ProductWithIncludes } from '../application/mappers/public-product.mapper';

function makeProduct(
  id: string,
  priceCents: number,
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento' },
    brand: { name: 'Brand' },
    images: [{ url: `https://cdn.example.com/${id}.jpg` }],
    priceLists: [{ priceCents }],
    variants: [],
    ...overrides,
  };
}

describe('PrismaPublicCatalogRepository (WARNING-01 regression)', () => {
  let repo: PrismaPublicCatalogRepository;
  let mockFindMany: jest.Mock;
  let mockCount: jest.Mock;
  let mockTenantFindMany: jest.Mock;

  beforeEach(() => {
    mockFindMany = jest.fn();
    mockCount = jest.fn();
    mockTenantFindMany = jest.fn().mockResolvedValue([]);

    const mockTenantPrisma = {
      getClient: () => ({
        product: {
          findMany: mockFindMany,
          count: mockCount,
          groupBy: jest.fn().mockResolvedValue([]),
        },
      }),
    } as unknown as TenantPrismaService;

    const mockPrisma = {
      category: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { findMany: mockTenantFindMany },
    } as unknown as PrismaService;

    repo = new PrismaPublicCatalogRepository(mockPrisma, mockTenantPrisma);
  });

  it('should sort price_asc by actual priceCents (cheapest first)', async () => {
    // Products returned from DB in arbitrary order
    mockFindMany.mockResolvedValue([
      makeProduct('expensive', 200000),
      makeProduct('cheap', 50000),
      makeProduct('mid', 100000),
    ]);
    mockCount.mockResolvedValue(3);

    const { items } = await repo.findProducts({
      sort: 'price_asc',
      page: 1,
      limit: 20,
    });

    // Must be sorted by priceCents ascending: 50000, 100000, 200000
    expect(items[0].priceLists[0].priceCents).toBe(50000);
    expect(items[1].priceLists[0].priceCents).toBe(100000);
    expect(items[2].priceLists[0].priceCents).toBe(200000);
  });

  it('should sort price_desc by actual priceCents (most expensive first)', async () => {
    mockFindMany.mockResolvedValue([
      makeProduct('cheap', 50000),
      makeProduct('mid', 100000),
      makeProduct('expensive', 200000),
    ]);
    mockCount.mockResolvedValue(3);

    const { items } = await repo.findProducts({
      sort: 'price_desc',
      page: 1,
      limit: 20,
    });

    // Must be sorted by priceCents descending: 200000, 100000, 50000
    expect(items[0].priceLists[0].priceCents).toBe(200000);
    expect(items[1].priceLists[0].priceCents).toBe(100000);
    expect(items[2].priceLists[0].priceCents).toBe(50000);
  });

  it('should place products with no price list last in price_asc', async () => {
    mockFindMany.mockResolvedValue([
      makeProduct('no-price', 0, { priceLists: [] }),
      makeProduct('cheap', 50000),
    ]);
    mockCount.mockResolvedValue(2);

    const { items } = await repo.findProducts({
      sort: 'price_asc',
      page: 1,
      limit: 20,
    });

    // Products with price come first, no-price products last
    expect(items[0].priceLists[0]?.priceCents).toBe(50000);
    expect(items[1].priceLists).toHaveLength(0);
  });

  it('should search by variant name and value when q is provided', async () => {
    let lastFindManyArgs: { where: { OR: unknown[] } } | undefined;

    mockFindMany.mockResolvedValue([]);
    mockFindMany.mockImplementation((args: { where: { OR: unknown[] } }) => {
      lastFindManyArgs = args;
      return Promise.resolve([]);
    });
    mockCount.mockResolvedValue(0);

    await repo.findProducts({
      q: '8 kg',
      sort: 'relevance',
      page: 1,
      limit: 20,
    });

    expect(lastFindManyArgs?.where.OR).toEqual(
      expect.arrayContaining([
        { name: { contains: '8 kg', mode: 'insensitive' } },
        {
          brand: {
            name: { contains: '8 kg', mode: 'insensitive' },
          },
        },
        {
          variants: {
            some: {
              catalogPublishMode: { not: 'OFF' },
              OR: [
                { name: { contains: '8 kg', mode: 'insensitive' } },
                { option: { contains: '8 kg', mode: 'insensitive' } },
                { value: { contains: '8 kg', mode: 'insensitive' } },
              ],
            },
          },
        },
      ]),
    );
  });

  describe('findActiveBranches publication gate', () => {
    it('should only list tenants that are both active and catalog-published', async () => {
      await repo.findActiveBranches();

      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, catalogPublished: true },
        }),
      );
    });

    it('should preserve branch mapping and name ordering', async () => {
      mockTenantFindMany.mockResolvedValue([
        {
          id: 'b1',
          name: 'Centro',
          slug: 'centro',
          address: 'Av. Juárez 123',
          phone: '+525512345678',
        },
        { id: 'b2', name: 'Norte', slug: 'norte', address: null, phone: null },
      ]);

      const branches = await repo.findActiveBranches();

      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { name: 'asc' } }),
      );
      expect(branches).toEqual([
        {
          id: 'b1',
          name: 'Centro',
          slug: 'centro',
          address: 'Av. Juárez 123',
          phone: '+525512345678',
        },
        { id: 'b2', name: 'Norte', slug: 'norte', address: null, phone: null },
      ]);
    });
  });
});

/** Shape of the Prisma query args captured from the mocked client (F1.WU5b). */
interface CapturedProductsQuery {
  include?: {
    priceLists?: { where?: { globalPriceListId?: string } };
    variants?: {
      select?: {
        variantPrices?: {
          where?: { priceList?: { globalPriceListId?: string } };
        };
      };
      include?: {
        variantPrices?: {
          where?: { priceList?: { globalPriceListId?: string } };
        };
      };
    };
  };
}

describe('F1.WU5b tenant catalog-default price context', () => {
  let repo: PrismaPublicCatalogRepository;
  let mockFindMany: jest.Mock;
  let mockCount: jest.Mock;
  let mockProductFindFirst: jest.Mock;
  let mockBindingFindFirst: jest.Mock;

  beforeEach(() => {
    mockFindMany = jest.fn().mockResolvedValue([]);
    mockCount = jest.fn().mockResolvedValue(0);
    mockProductFindFirst = jest.fn().mockResolvedValue(null);
    mockBindingFindFirst = jest.fn().mockResolvedValue(null);

    const mockTenantPrisma = {
      getClient: () => ({
        product: {
          findMany: mockFindMany,
          count: mockCount,
          findFirst: mockProductFindFirst,
          groupBy: jest.fn().mockResolvedValue([]),
        },
        tenantCatalogPriceList: { findFirst: mockBindingFindFirst },
      }),
      getTenantId: () => 'tenant-1',
    } as unknown as TenantPrismaService;

    const mockPrisma = {
      category: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    repo = new PrismaPublicCatalogRepository(mockPrisma, mockTenantPrisma);
  });

  it('resolves the tenant catalog-default global price list ID', async () => {
    mockBindingFindFirst.mockResolvedValue({ globalPriceListId: 'gpl-A' });

    const id = await repo.findTenantCatalogDefaultPriceListId();

    expect(id).toBe('gpl-A');
    expect(mockBindingFindFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', isCatalogDefault: true },
      select: { globalPriceListId: true },
    });
  });

  it('returns null when the tenant has no catalog-default binding', async () => {
    mockBindingFindFirst.mockResolvedValue(null);

    expect(await repo.findTenantCatalogDefaultPriceListId()).toBeNull();
  });

  it('findProducts filters product and variant prices by the threaded ID only', async () => {
    let capturedArgs: unknown;
    mockFindMany.mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve([]);
    });

    await repo.findProducts({
      sort: 'relevance',
      page: 1,
      limit: 20,
      globalPriceListId: 'gpl-A',
    });

    const args = capturedArgs as CapturedProductsQuery;

    expect(args.include?.priceLists?.where).toEqual({
      globalPriceListId: 'gpl-A',
    });
    expect(args.include?.variants?.select?.variantPrices?.where).toEqual({
      priceList: { globalPriceListId: 'gpl-A' },
    });
    expect(JSON.stringify(capturedArgs)).not.toContain('isDefault');
  });

  it('findProducts threads a different resolved ID unchanged', async () => {
    let capturedArgs: unknown;
    mockFindMany.mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve([]);
    });

    await repo.findProducts({
      sort: 'relevance',
      page: 1,
      limit: 20,
      globalPriceListId: 'gpl-B',
    });

    const args = capturedArgs as CapturedProductsQuery;

    expect(args.include?.priceLists?.where).toEqual({
      globalPriceListId: 'gpl-B',
    });
    expect(args.include?.variants?.select?.variantPrices?.where).toEqual({
      priceList: { globalPriceListId: 'gpl-B' },
    });
  });

  it('findProductById filters product and variant prices by the threaded ID only', async () => {
    let capturedArgs: unknown;
    mockProductFindFirst.mockImplementation((args: unknown) => {
      capturedArgs = args;
      return Promise.resolve(null);
    });

    await repo.findProductById('prod-1', 'gpl-A');

    const args = capturedArgs as CapturedProductsQuery;

    expect(args.include?.priceLists?.where).toEqual({
      globalPriceListId: 'gpl-A',
    });
    expect(args.include?.variants?.include?.variantPrices?.where).toEqual({
      priceList: { globalPriceListId: 'gpl-A' },
    });
    expect(JSON.stringify(capturedArgs)).not.toContain('isDefault');
  });
});

/**
 * F1.WU5c1 — the single publication-survivorship predicate every catalog
 * query must reuse. A product survives when it has no variants, or when
 * at least one variant is not OFF (INHERIT/ON). ON can never widen a
 * false parent gate because this is always ANDed with the parent gates.
 */
const PUBLICATION_SURVIVORSHIP = {
  OR: [
    { hasVariants: false },
    { variants: { some: { catalogPublishMode: { not: 'OFF' } } } },
  ],
};

describe('F1.WU5c1 repository publication gates', () => {
  let repo: PrismaPublicCatalogRepository;
  let findManyArgs: unknown;
  let countArgs: unknown;
  let groupByArgs: unknown;
  let findFirstArgs: unknown;

  beforeEach(() => {
    findManyArgs = undefined;
    countArgs = undefined;
    groupByArgs = undefined;
    findFirstArgs = undefined;

    const mockTenantPrisma = {
      getClient: () => ({
        product: {
          findMany: jest.fn().mockImplementation((args: unknown) => {
            findManyArgs = args;
            return Promise.resolve([]);
          }),
          count: jest.fn().mockImplementation((args: unknown) => {
            countArgs = args;
            return Promise.resolve(0);
          }),
          groupBy: jest.fn().mockImplementation((args: unknown) => {
            groupByArgs = args;
            return Promise.resolve([]);
          }),
          findFirst: jest.fn().mockImplementation((args: unknown) => {
            findFirstArgs = args;
            return Promise.resolve(null);
          }),
        },
      }),
      getTenantId: () => 'tenant-1',
    } as unknown as TenantPrismaService;

    const mockPrisma = {
      category: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    repo = new PrismaPublicCatalogRepository(mockPrisma, mockTenantPrisma);
  });

  it('list findMany keeps parent gates and adds the survivorship predicate', async () => {
    await repo.findProducts({ sort: 'relevance', page: 1, limit: 20 });

    const where = (findManyArgs as { where: Record<string, unknown> }).where;

    expect(where['includeInOnlineCatalog']).toBe(true);
    expect(where['type']).toBe('PRODUCT');
    expect(where['AND']).toEqual([PUBLICATION_SURVIVORSHIP]);
  });

  it('count reuses the exact survivorship where as findMany', async () => {
    await repo.findProducts({
      sort: 'relevance',
      page: 1,
      limit: 20,
      q: 'bottle',
    });

    const listWhere = (findManyArgs as { where: unknown }).where;
    const countWhere = (countArgs as { where: unknown }).where;

    expect(countWhere).toEqual(listWhere);
    expect(countWhere).toHaveProperty('AND', [PUBLICATION_SURVIVORSHIP]);
  });

  it('category facets group by the same survivorship predicate', async () => {
    await repo.findCategoryFacets({});

    const where = (groupByArgs as { where: Record<string, unknown> }).where;

    expect(where['includeInOnlineCatalog']).toBe(true);
    expect(where['type']).toBe('PRODUCT');
    expect(where['AND']).toEqual([PUBLICATION_SURVIVORSHIP]);
  });

  it('detail adds the missing type PRODUCT gate plus survivorship', async () => {
    await repo.findProductById('prod-1');

    const args = findFirstArgs as { where: unknown; include: unknown };

    expect(args.where).toEqual({
      id: 'prod-1',
      includeInOnlineCatalog: true,
      type: 'PRODUCT',
      AND: [PUBLICATION_SURVIVORSHIP],
    });
    expect(args.include).toBeDefined();
  });

  it('list variant projection filters out OFF variants', async () => {
    await repo.findProducts({ sort: 'relevance', page: 1, limit: 20 });

    const variants = (
      findManyArgs as {
        include: {
          variants: {
            where?: unknown;
            select?: unknown;
          };
        };
      }
    ).include.variants;

    expect(variants.where).toEqual({
      catalogPublishMode: { not: 'OFF' },
    });
    expect(variants.select).toBeDefined();
  });

  it('detail variant projection filters out OFF variants', async () => {
    await repo.findProductById('prod-1');

    const variants = (
      findFirstArgs as {
        include: { variants: { where?: unknown; include?: unknown } };
      }
    ).include.variants;

    expect(variants.where).toEqual({
      catalogPublishMode: { not: 'OFF' },
    });
    expect(variants.include).toBeDefined();
  });

  it('variant text search cannot be revealed by an OFF variant', async () => {
    await repo.findProducts({
      q: '8 kg',
      sort: 'relevance',
      page: 1,
      limit: 20,
    });

    const or = (
      findManyArgs as {
        where: { OR: Array<{ variants?: { some?: unknown } }> };
      }
    ).where.OR;

    const variantClause = or.find((c) => 'variants' in c);

    expect(variantClause?.variants?.some).toEqual({
      catalogPublishMode: { not: 'OFF' },
      OR: [
        { name: { contains: '8 kg', mode: 'insensitive' } },
        { option: { contains: '8 kg', mode: 'insensitive' } },
        { value: { contains: '8 kg', mode: 'insensitive' } },
      ],
    });
  });

  it('survivorship admits non-variant and INHERIT/ON products but not all-OFF', async () => {
    await repo.findProducts({ sort: 'relevance', page: 1, limit: 20 });

    const predicate = ((
      findManyArgs as {
        where: { AND: Record<string, unknown>[] };
      }
    ).where.AND ?? [])[0];

    expect(predicate).toEqual({
      OR: [
        { hasVariants: false },
        { variants: { some: { catalogPublishMode: { not: 'OFF' } } } },
      ],
    });
  });

  it('survivorship never widens a false parent gate (ANDed, not ORed)', async () => {
    await repo.findProducts({ sort: 'relevance', page: 1, limit: 20 });

    const where = (findManyArgs as { where: Record<string, unknown> }).where;

    // Parent gate stays a sibling requirement: only the AND conjunction
    // carries survivorship, so includeInOnlineCatalog=false still excludes.
    expect(where['includeInOnlineCatalog']).toBe(true);
    expect(where).not.toHaveProperty('OR');
  });
});

/**
 * F1.WU5c2 — the repository must carry catalogPublishMode through both
 * variant projections so the mapper can defensively enforce publication
 * for alternate/legacy callers that bypass the SQL gates.
 */
describe('F1.WU5c2 repository variant-mode projection', () => {
  let repo: PrismaPublicCatalogRepository;
  let findManyArgs: unknown;
  let findFirstArgs: unknown;

  beforeEach(() => {
    findManyArgs = undefined;
    findFirstArgs = undefined;

    const mockTenantPrisma = {
      getClient: () => ({
        product: {
          findMany: jest.fn().mockImplementation((args: unknown) => {
            findManyArgs = args;
            return Promise.resolve([]);
          }),
          count: jest.fn().mockResolvedValue(0),
          groupBy: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockImplementation((args: unknown) => {
            findFirstArgs = args;
            return Promise.resolve(null);
          }),
        },
      }),
      getTenantId: () => 'tenant-1',
    } as unknown as TenantPrismaService;

    const mockPrisma = {
      category: { findMany: jest.fn().mockResolvedValue([]) },
      tenant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    repo = new PrismaPublicCatalogRepository(mockPrisma, mockTenantPrisma);
  });

  it('list variant projection carries catalogPublishMode to the mapper (F1.WU5c2)', async () => {
    await repo.findProducts({ sort: 'relevance', page: 1, limit: 20 });

    const variants = (
      findManyArgs as {
        include: { variants: { select?: Record<string, unknown> } };
      }
    ).include.variants;

    expect(variants.select?.catalogPublishMode).toBe(true);
  });

  it('detail variant projection carries catalogPublishMode to the mapper (F1.WU5c2)', async () => {
    await repo.findProductById('prod-1');

    const variants = (
      findFirstArgs as {
        include: {
          variants: {
            where?: unknown;
            select?: unknown;
            include?: unknown;
          };
        };
      }
    ).include.variants;

    // The detail projection is include-based: every variant scalar —
    // catalogPublishMode included — reaches the mapper for its defensive
    // OFF filter. If this ever becomes a restrictive select, the mode must
    // be added explicitly.
    expect(variants.where).toEqual({ catalogPublishMode: { not: 'OFF' } });
    expect(variants.select).toBeUndefined();
    expect(variants.include).toBeDefined();
  });
});

describe('F2.WU6 resolveTenantCatalogContext', () => {
  const OK = {
    globalPriceListId: 'gpl-1',
    isCatalogDefault: false,
    globalPriceList: { name: 'Lista Mayoreo' },
    tenant: {
      id: 'tenant-1',
      slug: 'ctx-tenant',
      isActive: true,
      catalogPublished: true,
    },
  };
  const setup = (binding: unknown) => {
    const findFirst = jest.fn().mockResolvedValue(binding);
    const repo = new PrismaPublicCatalogRepository(
      {} as unknown as PrismaService,
      {
        getClient: () => ({ tenantCatalogPriceList: { findFirst } }),
      } as unknown as TenantPrismaService,
    );
    return { findFirst, repo };
  };

  it('resolves omitted (default) and supplied IDs through one exact predicate', async () => {
    const { findFirst, repo } = setup({ ...OK, isCatalogDefault: true });

    await expect(
      repo.resolveTenantCatalogContext?.('ctx-tenant'),
    ).resolves.toEqual({
      tenantId: 'tenant-1',
      tenantSlug: 'ctx-tenant',
      globalPriceListId: 'gpl-1',
      name: 'Lista Mayoreo',
      isCatalogDefault: true,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isCatalogDefault: true } }),
    );

    findFirst.mockResolvedValue(OK);
    await expect(
      repo.resolveTenantCatalogContext?.('ctx-tenant', 'gpl-9'),
    ).resolves.toMatchObject({ globalPriceListId: 'gpl-1' });
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { globalPriceListId: 'gpl-9' } }),
    );
  });

  it('collapses every miss into one null with exactly one lookup each', async () => {
    const { findFirst, repo } = setup(null);
    await expect(
      repo.resolveTenantCatalogContext?.('ctx-tenant', 'gpl-404'),
    ).resolves.toBeNull();

    // Slug mismatch and inactive/unpublished tenant rows fail closed too.
    findFirst
      .mockResolvedValueOnce({ ...OK, tenant: { ...OK.tenant, slug: 'other' } })
      .mockResolvedValueOnce({
        ...OK,
        tenant: { ...OK.tenant, isActive: false },
      })
      .mockResolvedValueOnce({
        ...OK,
        tenant: { ...OK.tenant, catalogPublished: false },
      });
    for (let i = 0; i < 3; i++) {
      await expect(
        repo.resolveTenantCatalogContext?.('ctx-tenant'),
      ).resolves.toBeNull();
    }
    expect(findFirst).toHaveBeenCalledTimes(4);
  });
});

interface CartCandidatesQuery {
  where?: Record<string, unknown>;
  select?: {
    priceLists?: { where?: Record<string, unknown> };
    variants?: {
      where?: Record<string, unknown>;
      select?: { variantPrices?: { where?: Record<string, unknown> } };
    };
    images?: { where?: Record<string, unknown> };
    catalogPriceLists?: { where?: Record<string, unknown> };
    [field: string]: unknown;
  };
}

/**
 * F2.WU7 slice 1 — dormant `findPublicCartCandidates` seam. Pure bulk-load:
 * tenant/context mismatch never reaches the database, nested predicates
 * repeat same-tenant ownership so a mutation cannot widen disclosure, and
 * no publication/stock/price decision is applied (OFF/excluded retained).
 */
describe('F2.WU7 slice 1 findPublicCartCandidates', () => {
  const context = (globalPriceListId: string) => ({
    tenantId: 'tenant-1',
    tenantSlug: 'ctx-tenant',
    globalPriceListId,
    name: 'Lista',
    isCatalogDefault: false,
  });
  const baseInput = {
    tenantId: 'tenant-1',
    context: context('gpl-A'),
    productIds: ['p-1', 'p-2'],
    variantIds: ['v-1'],
  };
  const WRITE_DELEGATES =
    'create update upsert delete createMany updateMany deleteMany'.split(' ');

  let findMany: jest.Mock<Promise<unknown[]>, [CartCandidatesQuery]>;
  let writeDelegates: jest.Mock<Promise<unknown>, []>[];

  const buildRepo = () =>
    new PrismaPublicCatalogRepository(
      {} as unknown as PrismaService,
      {
        getClient: () => ({
          product: {
            findMany,
            ...Object.fromEntries(
              WRITE_DELEGATES.map((name, i) => [name, writeDelegates[i]]),
            ),
          },
        }),
        getTenantId: () => 'tenant-1',
      } as unknown as TenantPrismaService,
    );

  beforeEach(() => {
    findMany = jest
      .fn<Promise<unknown[]>, [CartCandidatesQuery]>()
      .mockResolvedValue([]);
    writeDelegates = WRITE_DELEGATES.map((name) =>
      jest.fn<Promise<unknown>, []>().mockName(name),
    );
  });

  it('returns no candidates on tenant/context mismatch without any database call', async () => {
    const repo = buildRepo();

    const result = await repo.findPublicCartCandidates?.({
      ...baseInput,
      tenantId: 'tenant-2',
    });

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    writeDelegates.forEach((d) => expect(d).not.toHaveBeenCalled());
  });

  it('issues exactly one tenant-scoped product.findMany limited to requested IDs', async () => {
    const repo = buildRepo();

    await repo.findPublicCartCandidates?.(baseInput);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      tenantId: 'tenant-1',
      id: { in: ['p-1', 'p-2'] },
    });
    expect(args.select).toBeDefined();
    writeDelegates.forEach((d) => expect(d).not.toHaveBeenCalled());
  });

  it('projects exact selected-context positive prices; different lists differ', async () => {
    const repo = buildRepo();

    await repo.findPublicCartCandidates?.(baseInput);
    await repo.findPublicCartCandidates?.({
      ...baseInput,
      context: context('gpl-B'),
    });

    const [a, b] = findMany.mock.calls.map((c) => c[0]);
    expect(a.select?.priceLists?.where).toEqual({
      tenantId: 'tenant-1',
      globalPriceListId: 'gpl-A',
      priceCents: { gt: 0 },
    });
    expect(a.select?.variants?.select?.variantPrices?.where).toEqual({
      tenantId: 'tenant-1',
      priceList: { tenantId: 'tenant-1', globalPriceListId: 'gpl-A' },
      priceCents: { gt: 0 },
    });
    expect(b.select?.priceLists?.where).toEqual({
      tenantId: 'tenant-1',
      globalPriceListId: 'gpl-B',
      priceCents: { gt: 0 },
    });
    expect(a.select?.priceLists?.where).not.toEqual(
      b.select?.priceLists?.where,
    );
    expect(a.select?.variants?.select?.variantPrices?.where).not.toEqual(
      b.select?.variants?.select?.variantPrices?.where,
    );
  });

  it('empty variantIds loads no variants; requested variants stay tenant-scoped', async () => {
    const repo = buildRepo();

    await repo.findPublicCartCandidates?.({ ...baseInput, variantIds: [] });
    expect(findMany.mock.calls[0][0].select?.variants?.where).toEqual({
      tenantId: 'tenant-1',
      id: { in: [] },
    });

    await repo.findPublicCartCandidates?.({
      ...baseInput,
      variantIds: ['v-1', 'v-2'],
    });
    expect(findMany.mock.calls[1][0].select?.variants?.where).toEqual({
      tenantId: 'tenant-1',
      id: { in: ['v-1', 'v-2'] },
    });
  });

  it('projects main image, allowlist rows, and stock fields without default/fallback/write queries', async () => {
    const repo = buildRepo();

    await repo.findPublicCartCandidates?.(baseInput);

    const args = findMany.mock.calls[0][0];
    expect(args.select?.images?.where).toEqual({
      isMain: true,
      variantId: null,
    });
    expect(args.select?.catalogPriceLists?.where).toEqual({
      tenantId: 'tenant-1',
    });
    for (const field of [
      'type',
      'includeInOnlineCatalog',
      'hasVariants',
      'useStock',
      'quantity',
      'minQuantity',
      'hidePriceInOnlineCatalog',
      'requiresPrescription',
    ]) {
      expect(args.select?.[field]).toBe(true);
    }
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain('isDefault');
    expect(serialized).not.toContain('OFF');
    writeDelegates.forEach((d) => expect(d).not.toHaveBeenCalled());
  });

  it('retains excluded/SERVICE products and OFF variants with empty exact prices for later reconciliation', async () => {
    findMany.mockResolvedValue([
      {
        id: 'p-svc',
        name: 'Servicio',
        type: 'SERVICE',
        includeInOnlineCatalog: true,
        hasVariants: false,
        useStock: true,
        quantity: 0,
        minQuantity: 1,
        hidePriceInOnlineCatalog: false,
        requiresPrescription: false,
        images: [{ url: 'https://cdn.example.com/main.jpg' }],
        catalogPriceLists: [{ globalPriceListId: 'gpl-A' }],
        priceLists: [],
        variants: [],
      },
      {
        id: 'p-off',
        name: 'Con OFF',
        type: 'PRODUCT',
        includeInOnlineCatalog: false,
        hasVariants: true,
        useStock: false,
        quantity: 9,
        minQuantity: 2,
        hidePriceInOnlineCatalog: true,
        requiresPrescription: false,
        images: [],
        catalogPriceLists: [],
        priceLists: [{ priceCents: 1200 }],
        variants: [
          {
            id: 'v-1',
            name: 'V1',
            catalogPublishMode: 'OFF',
            quantity: 4,
            minQuantity: 1,
            variantPrices: [],
          },
        ],
      },
    ]);
    const repo = buildRepo();

    const candidates = await repo.findPublicCartCandidates?.(baseInput);

    expect(candidates).toHaveLength(2);
    expect(candidates?.[0]).toMatchObject({
      type: 'SERVICE',
      includeInOnlineCatalog: true,
      priceLists: [],
      images: [{ url: 'https://cdn.example.com/main.jpg' }],
      catalogPriceLists: [{ globalPriceListId: 'gpl-A' }],
    });
    expect(candidates?.[1]).toMatchObject({
      includeInOnlineCatalog: false,
      useStock: false,
      quantity: 9,
      minQuantity: 2,
      priceLists: [{ priceCents: 1200 }],
      variants: [
        {
          id: 'v-1',
          catalogPublishMode: 'OFF',
          quantity: 4,
          minQuantity: 1,
          variantPrices: [],
        },
      ],
    });
  });
});
