import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
import type { Product } from './domain/product.entity';
type UpsertVariantPriceDto = Parameters<
  ProductsService['upsertVariantPrice']
>[3];
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { makeStockJournalStub } from './infrastructure/product-stock-journal.test-support';

type Tier = { id: string; minQuantity: number; priceCents: number };
type Stored = { priceCents: number; tiers: Tier[] } | null;
function setup(existing = true) {
  let inside = false;
  let productCost = 100;
  let variantCost: number | null = null;
  let costFailure: Error | undefined;
  let stored: Stored = existing
    ? {
        priceCents: 500,
        tiers: [{ id: 'old', minQuantity: 3, priceCents: 400 }],
      }
    : null;
  const events: string[] = [];
  const record = (name: string) => {
    if (!inside) throw new Error(`Uncoordinated ${name}`);
    events.push(name);
  };
  const product = {
    get purchaseCost() {
      record('enrich');
      if (costFailure) throw costFailure;
      return { netCents: productCost };
    },
  } as Product;
  const rootAccess = jest.fn(() => {
    throw new Error('Unexpected root access');
  });
  const root = new Proxy({}, { get: rootAccess });
  const repo = {
    findById: jest.fn<Promise<Product | null>, [string]>(() => {
      record('product');
      return Promise.resolve(product);
    }),
  };
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('lifecycle');
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn<Promise<{ id: string }[]>, [Prisma.Sql]>(() => {
      record('gate');
      return Promise.resolve([{ id: 'product' }]);
    }),
    variant: {
      findFirst: jest.fn<
        Promise<{
          id: string;
          productId: string;
          purchaseNetCostCents: number | null;
        } | null>,
        [unknown]
      >(() => {
        record('variant');
        return Promise.resolve({
          id: 'variant',
          productId: 'product',
          purchaseNetCostCents: variantCost,
        });
      }),
    },
    priceList: {
      findUnique: jest.fn<
        Promise<{
          id: string;
          productId: string;
          globalPriceList: { isDefault: boolean };
        } | null>,
        [unknown]
      >(() => {
        record('list');
        return Promise.resolve({
          id: 'list',
          productId: 'product',
          globalPriceList: { isDefault: true },
        });
      }),
    },
    variantPrice: {
      upsert: jest.fn(
        ({
          update,
          create,
        }: {
          where: unknown;
          update: { priceCents: number };
          create: {
            priceCents: number;
            tenantId: string;
            variantId: string;
            priceListId: string;
          };
        }) => {
          record('upsert');
          stored = stored
            ? { ...stored, priceCents: update.priceCents }
            : { priceCents: create.priceCents, tiers: [] };
          return Promise.resolve({ id: 'price' });
        },
      ),
      findUnique: jest.fn<
        Promise<{
          id: string;
          variantId: string;
          priceListId: string;
          priceCents: number;
          priceList: { id: string; globalPriceList: { name: string } };
          tierPrices: Tier[];
        } | null>,
        [unknown]
      >(() => {
        record('result');
        return Promise.resolve(
          stored
            ? {
                id: 'price',
                variantId: 'variant',
                priceListId: 'list',
                priceCents: stored.priceCents,
                priceList: { id: 'list', globalPriceList: { name: 'PUBLICO' } },
                tierPrices: structuredClone(stored.tiers).sort(
                  (a, b) => a.minQuantity - b.minQuantity,
                ),
              }
            : null,
        );
      }),
    },
    variantTierPrice: {
      deleteMany: jest.fn<Promise<void>, [unknown]>(() => {
        record('clear');
        if (stored) stored.tiers = [];
        return Promise.resolve();
      }),
      createMany: jest.fn(
        ({
          data,
        }: {
          data: Array<
            Omit<Tier, 'id'> & { tenantId: string; variantPriceId: string }
          >;
        }) => {
          record('tiers');
          if (stored)
            stored.tiers = data.map(({ minQuantity, priceCents }, i) => ({
              id: `tier-${i}`,
              minQuantity,
              priceCents,
            }));
          return Promise.resolve();
        },
      ),
    },
  };
  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    if (inside) return work();
    const before = structuredClone(stored);
    inside = true;
    events.push('begin');
    try {
      const result = await work();
      events.push('commit');
      return result;
    } catch (error) {
      stored = before;
      events.push('rollback');
      throw error;
    } finally {
      inside = false;
    }
  }
  const tenant = {
    getTenantId: () => 'tenant',
    getClient: () => (inside ? tx : root),
    runInTransaction: jest.fn(transaction),
  };
  type Args = ConstructorParameters<typeof ProductsService>;
  const service = new ProductsService(
    repo as unknown as Args[0],
    root as Args[1],
    {} as Args[2],
    tenant as unknown as Args[3],
    {} as Args[4],
    makeStockJournalStub(),
  );
  return {
    tx,
    repo,
    tenant,
    events,
    rootAccess,
    transaction,
    upsert: (dto: UpsertVariantPriceDto = { priceCents: 1000 }) =>
      service.upsertVariantPrice('product', 'variant', 'list', dto),
    snapshot: () => structuredClone(stored),
    costs: (parent: number, variant: number | null) => {
      productCost = parent;
      variantCost = variant;
    },
    failEnrichment: (error: Error) => {
      costFailure = error;
    },
  };
}

it('gates every observation and retains the transaction through response enrichment', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('gate');
    s.costs(333, null);
    return Promise.resolve([{ id: 'product' }]);
  });
  const result = await s.upsert({
    priceCents: 1000,
    tierPrices: [{ minQuantity: 2, priceCents: 500 }],
  });
  expect(s.events).toEqual([
    'begin',
    'lifecycle',
    'gate',
    'product',
    'variant',
    'list',
    'upsert',
    'clear',
    'tiers',
    'result',
    'enrich',
    'commit',
  ]);
  expect(s.tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
    'LOCK TABLE "global_price_lists" IN SHARE MODE',
  ]);
  const query = s.tx.$queryRaw.mock.calls[0][0];
  expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT "id" FROM "products" WHERE "tenantId" = ? AND "id" = ? FOR UPDATE',
  );
  expect(query.values).toEqual(['tenant', 'product']);
  expect(s.repo.findById).toHaveBeenCalledWith('product');
  expect(s.tx.variant.findFirst.mock.calls[0][0]).toMatchObject({
    where: { id: 'variant', tenantId: 'tenant' },
  });
  expect(s.tx.priceList.findUnique.mock.calls[0][0]).toMatchObject({
    where: { id: 'list', tenantId: 'tenant' },
  });
  expect(s.tx.variantPrice.upsert).toHaveBeenCalledWith({
    where: {
      tenantId_variantId_priceListId: {
        tenantId: 'tenant',
        variantId: 'variant',
        priceListId: 'list',
      },
    },
    update: { priceCents: 1000 },
    create: {
      tenantId: 'tenant',
      variantId: 'variant',
      priceListId: 'list',
      priceCents: 1000,
    },
  });
  expect(s.tx.variantTierPrice.deleteMany).toHaveBeenCalledWith({
    where: { variantPriceId: 'price', tenantId: 'tenant' },
  });
  expect(s.tx.variantTierPrice.createMany).toHaveBeenCalledWith({
    data: [
      {
        tenantId: 'tenant',
        variantPriceId: 'price',
        minQuantity: 2,
        priceCents: 500,
      },
    ],
  });
  expect(s.tx.variantPrice.findUnique).toHaveBeenCalledWith({
    where: {
      tenantId_variantId_priceListId: {
        tenantId: 'tenant',
        variantId: 'variant',
        priceListId: 'list',
      },
    },
    include: {
      priceList: {
        select: { id: true, globalPriceList: { select: { name: true } } },
      },
      tierPrices: { orderBy: { minQuantity: 'asc' } },
    },
  });
  expect(result).toEqual({
    id: 'price',
    variantId: 'variant',
    priceListId: 'list',
    priceListName: 'PUBLICO',
    priceCents: 1000,
    priceDecimal: 10,
    margin: { amountCents: 667, amountDecimal: 6.67, percent: 67 },
    tierPrices: [
      {
        id: 'tier-0',
        minQuantity: 2,
        priceCents: 500,
        priceDecimal: 5,
        margin: { amountCents: 167, amountDecimal: 1.67, percent: 33 },
      },
    ],
  });
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
  expect(s.rootAccess).not.toHaveBeenCalled();
});

it.each(['gate', 'product', 'variant', 'list', 'result'])(
  'preserves missing or tenant-invisible %s errors',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    if (stage === 'gate') s.tx.$queryRaw.mockResolvedValue([]);
    if (stage === 'product') s.repo.findById.mockResolvedValue(null);
    if (stage === 'variant') s.tx.variant.findFirst.mockResolvedValue(null);
    if (stage === 'list') s.tx.priceList.findUnique.mockResolvedValue(null);
    if (stage === 'result')
      s.tx.variantPrice.findUnique.mockResolvedValue(null);
    const entity =
      stage === 'gate' || stage === 'product'
        ? 'Product'
        : stage === 'variant'
          ? 'Variant'
          : stage === 'list'
            ? 'PriceList'
            : 'VariantPrice';
    const id =
      entity === 'Product'
        ? 'product'
        : entity === 'Variant'
          ? 'variant'
          : entity === 'PriceList'
            ? 'list'
            : 'variant:list';
    await expect(
      s.upsert({
        priceCents: 0,
        tierPrices:
          stage === 'result' ? [] : [{ minQuantity: -1, priceCents: 0 }],
      }),
    ).rejects.toEqual(new EntityNotFoundError(entity, id));
    expect(s.tx.variantPrice.upsert).toHaveBeenCalledTimes(
      stage === 'result' ? 1 : 0,
    );
    expect(s.snapshot()).toEqual(before);
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.rootAccess).not.toHaveBeenCalled();
  },
);

it.each(['variant', 'list'])(
  'preserves same-tenant %s mismatch before validation',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    if (stage === 'variant')
      s.tx.variant.findFirst.mockResolvedValue({
        id: 'variant',
        productId: 'other',
        purchaseNetCostCents: null,
      });
    else
      s.tx.priceList.findUnique.mockResolvedValue({
        id: 'list',
        productId: 'other',
        globalPriceList: { isDefault: true },
      });
    await expect(
      s.upsert({
        priceCents: 0,
        tierPrices: [{ minQuantity: -1, priceCents: 0 }],
      }),
    ).rejects.toEqual(
      new BusinessRuleViolationError(
        stage === 'variant'
          ? 'Variant does not belong to the product'
          : 'Price list does not belong to the product',
        stage === 'variant'
          ? 'VARIANT_PRODUCT_MISMATCH'
          : 'PRICE_LIST_PRODUCT_MISMATCH',
      ),
    );
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);

it.each([
  [[0.5], 'Tier quantity thresholds must be integers >= 0'],
  [[-1], 'Tier quantity thresholds must be >= 0'],
  [[2, 2], 'Tier thresholds must be unique. Duplicate value: 2'],
  [[3, 1], 'Tier thresholds must be strictly ascending and unique: 3 -> 1'],
] as const)(
  'retains tier validation %s',
  async (quantities: readonly number[], message: string) => {
    const s = setup();
    const before = s.snapshot();
    await expect(
      s.upsert({
        priceCents: 0,
        tierPrices: quantities.map((minQuantity) => ({
          minQuantity,
          priceCents: 0,
        })),
      }),
    ).rejects.toEqual(new InvalidArgumentError(message));
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);

it.each([false, true])(
  'preserves prices, PUBLICO and three-state tiers with existing=%s',
  async (existing) => {
    for (const cost of [null, 0, 333])
      for (const priceCents of [0, 500])
        for (const tierPrices of [
          undefined,
          [],
          [
            { minQuantity: 0, priceCents: 0 },
            { minQuantity: 2, priceCents: 500 },
          ],
        ]) {
          const s = setup(existing);
          s.costs(700, cost);
          const before = s.snapshot();
          const result = await s.upsert({ priceCents, tierPrices });
          const net = cost ?? 700;
          const margin = (price: number) => ({
            amountCents: price - net,
            amountDecimal: (price - net) / 100,
            percent: price > 0 ? Math.round(((price - net) / price) * 100) : 0,
          });
          const expected =
            tierPrices === undefined
              ? (before?.tiers ?? [])
              : tierPrices.map((t, i) => ({ id: `tier-${i}`, ...t }));
          expect(result).toEqual({
            id: 'price',
            variantId: 'variant',
            priceListId: 'list',
            priceListName: 'PUBLICO',
            priceCents,
            priceDecimal: priceCents / 100,
            margin: margin(priceCents),
            tierPrices: expected.map((t) => ({
              ...t,
              priceDecimal: t.priceCents / 100,
              margin: margin(t.priceCents),
            })),
          });
          expect(s.snapshot()).toEqual({ priceCents, tiers: expected });
          expect(s.tx.variantTierPrice.deleteMany).toHaveBeenCalledTimes(
            tierPrices === undefined ? 0 : 1,
          );
          expect(s.tx.variantTierPrice.createMany).toHaveBeenCalledTimes(
            tierPrices?.length ? 1 : 0,
          );
          expect(s.events.at(-1)).toBe('commit');
          expect(s.rootAccess).not.toHaveBeenCalled();
        }
  },
);

it.each([
  'lifecycle',
  'gate',
  'product',
  'variant',
  'list',
  'upsert',
  'clear',
  'tiers',
  'result',
  'enrich',
])('rolls back all effects on %s failure', async (stage) => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('sentinel');
  const methods = {
    lifecycle: s.tx.$executeRaw,
    gate: s.tx.$queryRaw,
    product: s.repo.findById,
    variant: s.tx.variant.findFirst,
    list: s.tx.priceList.findUnique,
    upsert: s.tx.variantPrice.upsert,
    clear: s.tx.variantTierPrice.deleteMany,
    tiers: s.tx.variantTierPrice.createMany,
    result: s.tx.variantPrice.findUnique,
  };
  if (stage === 'enrich') s.failEnrichment(error);
  else methods[stage as keyof typeof methods].mockRejectedValue(error);
  await expect(
    s.upsert({
      priceCents: 0,
      tierPrices: [{ minQuantity: 0, priceCents: 0 }],
    }),
  ).rejects.toBe(error);
  expect(s.snapshot()).toEqual(before);
  if (stage === 'lifecycle') {
    expect(s.events).toEqual(['begin', 'rollback']);
    expect(s.tx.$queryRaw).not.toHaveBeenCalled();
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
  }
  expect(s.events.at(-1)).toBe('rollback');
  expect(s.events).not.toContain('commit');
});

it('joins ambient ownership and restores price and tiers on late failure', async () => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('late failure');
  await expect(
    s.transaction(async () => {
      await s.upsert({ priceCents: 0, tierPrices: [] });
      expect(s.snapshot()).toEqual({ priceCents: 0, tiers: [] });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(s.snapshot()).toEqual(before);
  expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
  expect(s.events.at(-1)).toBe('rollback');
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
});

it.each([false, true])(
  'awaits lifecycle and reads fresh list/cost, vanished=%s',
  async (vanished) => {
    const s = setup();
    const before = s.snapshot();
    let release!: () => void;
    const gate = new Promise<number>((resolve) => (release = () => resolve(0)));
    s.tx.$executeRaw.mockImplementation(() => {
      s.events.push('lifecycle');
      return gate;
    });
    const pending = s.upsert().then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await Promise.resolve();
      expect(s.events).toEqual(['begin', 'lifecycle']);
      expect(s.tx.$queryRaw).not.toHaveBeenCalled();
      expect(s.repo.findById).not.toHaveBeenCalled();
      expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
      expect(s.tx.priceList.findUnique).not.toHaveBeenCalled();
      expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
      expect(s.tx.variantTierPrice.deleteMany).not.toHaveBeenCalled();
      expect(s.tx.variantTierPrice.createMany).not.toHaveBeenCalled();
      expect(s.tx.variantPrice.findUnique).not.toHaveBeenCalled();
      expect(s.snapshot()).toEqual(before);
      s.costs(250, null);
      if (vanished) s.tx.priceList.findUnique.mockResolvedValue(null);
    } finally {
      release();
      await pending;
    }
    if (vanished) {
      await expect(pending).resolves.toEqual(
        new EntityNotFoundError('PriceList', 'list'),
      );
      expect(s.snapshot()).toEqual(before);
      expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    } else
      await expect(pending).resolves.toEqual({
        id: 'price',
        variantId: 'variant',
        priceListId: 'list',
        priceListName: 'PUBLICO',
        priceCents: 1000,
        priceDecimal: 10,
        margin: { amountCents: 750, amountDecimal: 7.5, percent: 75 },
        tierPrices: [
          {
            id: 'old',
            minQuantity: 3,
            priceCents: 400,
            priceDecimal: 4,
            margin: { amountCents: 150, amountDecimal: 1.5, percent: 38 },
          },
        ],
      });
    expect(s.rootAccess).not.toHaveBeenCalled();
  },
);

it('reacquires shared ownership and preserves tiers in repeated ambient upserts', async () => {
  const s = setup();
  await s.transaction(async () => {
    const first = await s.upsert({ priceCents: 1000 });
    s.costs(200, 0);
    const second = await s.upsert({ priceCents: 500 });
    expect(second).toEqual({
      ...first,
      priceCents: 500,
      priceDecimal: 5,
      margin: { amountCents: 500, amountDecimal: 5, percent: 100 },
      tierPrices: [
        {
          id: 'old',
          minQuantity: 3,
          priceCents: 400,
          priceDecimal: 4,
          margin: { amountCents: 400, amountDecimal: 4, percent: 100 },
        },
      ],
    });
    expect(s.events).not.toContain('commit');
    expect(s.tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
      'LOCK TABLE "global_price_lists" IN SHARE MODE',
      'LOCK TABLE "global_price_lists" IN SHARE MODE',
    ]);
    expect(s.snapshot()).toEqual({
      priceCents: 500,
      tiers: [{ id: 'old', minQuantity: 3, priceCents: 400 }],
    });
  });
  expect(s.events.filter((event) => event === 'begin')).toHaveLength(1);
  expect(s.events.filter((event) => event === 'commit')).toHaveLength(1);
  expect(s.tx.variantTierPrice.deleteMany).not.toHaveBeenCalled();
  s.tenant.runInTransaction.mock.calls.forEach((args) =>
    expect(args).toEqual([expect.any(Function)]),
  );
  expect(s.rootAccess).not.toHaveBeenCalled();
});
