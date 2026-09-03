import { Product } from './domain/product.entity';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { ProductsService } from './products.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LIST_A = '550e8400-e29b-41d4-a716-446655440000';
const LIST_B = '660e8400-e29b-41d4-a716-446655440001';
const STALE = '770e8400-e29b-41d4-a716-446655440002';
const ERROR = 'Catalog price list selection is invalid';
type Row = Record<string, unknown>;

function harness(
  options: {
    bound?: string[];
    failJoin?: Error;
    failTail?: Error;
  } = {},
) {
  const events: string[] = [];
  let ambient = false;
  let physicalTransactions = 0;
  let committed = {
    product: {
      ...Product.create({ id: 'product-1', name: 'Old name' }).toPersistence(),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    } as Row,
    joins: [STALE],
  };
  let working = committed;
  const row = (state: typeof committed) => ({
    ...state.product,
    serviceDetail: null,
    catalogPriceLists: state.joins.map((globalPriceListId) => ({
      globalPriceListId,
    })),
  });
  const productDelegate = (state: () => typeof committed) => ({
    findUnique: jest.fn((args: Row) => {
      events.push(ambient ? 'tx:product-read' : 'product-read');
      return Promise.resolve(
        args.select ? { category: null, brand: null } : row(state()),
      );
    }),
    upsert: jest.fn(({ update }: { update: Row }) => {
      events.push('upsert');
      working.product = { ...working.product, ...update };
      return Promise.resolve(row(working));
    }),
  });
  const tx = {
    product: productDelegate(() => working),
    productCatalogPriceList: {
      deleteMany: jest.fn(() => {
        events.push('join-delete');
        working.joins = [];
        return Promise.resolve({ count: 1 });
      }),
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        events.push('join-create');
        if (options.failJoin) throw options.failJoin;
        working.joins = data.map((item) => item.globalPriceListId as string);
        return Promise.resolve({ count: data.length });
      }),
    },
    serviceDetail: {
      deleteMany: jest.fn(() => {
        events.push('tail');
        if (options.failTail) throw options.failTail;
        return Promise.resolve({ count: 0 });
      }),
    },
  };
  const root = {
    product: productDelegate(() => committed),
    tenantCatalogPriceList: {
      findMany: jest.fn(({ where }: { where: Row }) => {
        events.push('binding-query');
        const requested = (where.globalPriceListId as { in: string[] }).in;
        return Promise.resolve(
          (options.bound ?? [])
            .filter((id) => requested.includes(id))
            .map((globalPriceListId) => ({ globalPriceListId })),
        );
      }),
    },
    globalPriceList: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    priceList: { findMany: jest.fn(() => Promise.resolve([])) },
    productImage: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const tenantPrisma = {
    getTenantId: jest.fn(() => TENANT),
    getClient: jest.fn(() => (ambient ? tx : root)),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      events.push('tx:logical');
      if (ambient) return work();
      physicalTransactions += 1;
      working = {
        product: { ...committed.product },
        joins: [...committed.joins],
      };
      ambient = true;
      try {
        const result = await work();
        committed = working;
        return result;
      } finally {
        ambient = false;
      }
    }),
  };
  const repo = new PrismaProductRepository(
    tenantPrisma as never,
    { publish: jest.fn() } as never,
    { seedAndFlip: jest.fn(), rearm: jest.fn() } as never,
  );
  const service = new ProductsService(
    repo,
    root as never,
    {} as never,
    tenantPrisma as never,
    { assertExists: jest.fn() } as never,
  );
  return {
    service,
    root,
    tx,
    events,
    repo,
    committed: () => committed,
    physicalTransactions: () => physicalTransactions,
  };
}

function expectGeneric(error: unknown) {
  expect(error).toMatchObject({
    name: 'InvalidArgumentError',
    code: 'INVALID_ARGUMENT',
    message: ERROR,
  });
}

describe('ProductsService PATCH catalog allowlist (F1.WU4c3)', () => {
  it('normalizes and validates a non-empty replacement before the one physical transaction', async () => {
    const h = harness({ bound: [LIST_A, LIST_B] });

    const response = await h.service.update('product-1', {
      name: 'New name',
      supportedCatalogPriceListIds: [LIST_A.toUpperCase(), LIST_B],
    });

    expect(h.root.tenantCatalogPriceList.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        globalPriceListId: { in: [LIST_A, LIST_B] },
      },
      select: { globalPriceListId: true },
    });
    expect(h.committed().joins).toEqual(
      expect.arrayContaining([LIST_A, LIST_B]),
    );
    expect(h.committed().joins).toHaveLength(2);
    expect(response).toMatchObject({
      name: 'New name',
      supportsAllCatalogPriceLists: false,
    });
    expect(response.supportedCatalogPriceListIds).toEqual(
      expect.arrayContaining([LIST_A, LIST_B]),
    );
    expect(response.supportedCatalogPriceListIds).toHaveLength(2);
    expect(h.events.indexOf('binding-query')).toBeLessThan(
      h.events.indexOf('tx:logical'),
    );
    expect(h.physicalTransactions()).toBe(1);
    expect(h.events.filter((event) => event === 'tx:logical')).toHaveLength(2);
  });

  it('clears on explicit [] and returns all-public semantics', async () => {
    const h = harness();
    const response = await h.service.update('product-1', {
      supportedCatalogPriceListIds: [],
    });

    expect(h.root.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
    expect(h.committed().joins).toEqual([]);
    expect(h.tx.productCatalogPriceList.createMany).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      supportsAllCatalogPriceLists: true,
      supportedCatalogPriceListIds: [],
    });
  });

  it('preserves stale IDs when an own allowlist property is undefined', async () => {
    const h = harness();
    const response = await h.service.update('product-1', {
      supportedCatalogPriceListIds: undefined,
    });

    expect(h.root.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
    expect(h.committed().joins).toEqual([STALE]);
    expect(response.supportedCatalogPriceListIds).toEqual([STALE]);
  });

  it.each([
    ['omitted', {}],
    ['name-only', { name: 'Renamed' }],
  ])(
    'preserves stale loaded IDs for %s PATCH without binding lookup',
    async (_, dto) => {
      const h = harness();
      const response = await h.service.update('product-1', dto);

      expect(h.root.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
      expect(h.committed().joins).toEqual([STALE]);
      expect(response.supportedCatalogPriceListIds).toEqual(
        expect.arrayContaining([STALE]),
      );
      expect(response.supportedCatalogPriceListIds).toHaveLength(1);
      // F1.WU4c4 — retained (non-empty) rows must keep the narrowed flag.
      expect(response.supportsAllCatalogPriceLists).toBe(false);
    },
  );

  it.each([
    ['non-array', LIST_A],
    ['non-string member', [LIST_A, 7]],
    ['exact duplicate', [LIST_A, LIST_A]],
    ['case duplicate', [LIST_A, LIST_A.toUpperCase()]],
  ])(
    'rejects %s before product lookup, mutation, or transaction',
    async (_, ids) => {
      const h = harness();
      const promise = h.service.update('product-1', {
        supportedCatalogPriceListIds: ids,
      } as never);

      await promise.then(() => {
        throw new Error('expected rejection');
      }, expectGeneric);
      expect(h.root.product.findUnique).not.toHaveBeenCalled();
      expect(h.root.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
      expect(h.physicalTransactions()).toBe(0);
      expect(h.committed()).toMatchObject({
        product: { name: 'Old name' },
        joins: [STALE],
      });
    },
  );

  it.each([
    ['unavailable', [LIST_A], []],
    ['mixed invalid', [LIST_A, LIST_B], [LIST_A]],
  ])(
    'rejects %s IDs generically before mutation/write/response',
    async (_, ids, bound) => {
      const h = harness({ bound });
      await h.service
        .update('product-1', {
          name: 'Changed',
          supportedCatalogPriceListIds: ids,
        })
        .then(() => {
          throw new Error('expected rejection');
        }, expectGeneric);

      expect(h.root.globalPriceList.findFirst).not.toHaveBeenCalled();
      expect(h.root.globalPriceList.findMany).not.toHaveBeenCalled();
      expect(h.tx.product.upsert).not.toHaveBeenCalled();
      expect(h.physicalTransactions()).toBe(0);
      expect(h.committed()).toMatchObject({
        product: { name: 'Old name' },
        joins: [STALE],
      });
      expect(h.root.priceList.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['join', { failJoin: new Error('join failed') }],
    ['tail', { failTail: new Error('tail failed') }],
  ])(
    'rolls back committed product and joins on %s failure with no response',
    async (_, options) => {
      const h = harness({ bound: [LIST_A], ...options });
      await expect(
        h.service.update('product-1', {
          name: 'Changed',
          supportedCatalogPriceListIds: [LIST_A],
        }),
      ).rejects.toBe(Object.values(options)[0]);

      expect(h.committed()).toMatchObject({
        product: { name: 'Old name' },
        joins: [STALE],
      });
      expect(h.root.priceList.findMany).not.toHaveBeenCalled();
    },
  );
});
