import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
import type { Product } from './domain/product.entity';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';

type Item = Parameters<
  ProductsService['bulkUpsertVariantPrices']
>[2]['prices'][number];
type Tier = { id: string; minQuantity: number; priceCents: number };
type Row = {
  id: string;
  tenantId: string;
  variantId: string;
  priceListId: string;
  priceCents: number;
  tierPrices: Tier[];
  priceList: { id: string; globalPriceList: { name: string } };
};
const identity = { tenantId: 'tenant', variantId: 'variant' };
function setup() {
  let inside = false;
  let allowRoot = false;
  let cost = 100;
  let override: number | null = null;
  const events: string[] = [];
  const lists = [
    { id: 'A', productId: 'product', tenantId: 'tenant', name: 'Alpha' },
    { id: 'B', productId: 'product', tenantId: 'tenant', name: 'Beta' },
    { id: 'C', productId: 'product', tenantId: 'tenant', name: 'PUBLICO' },
    {
      id: 'F',
      productId: 'foreign-product',
      tenantId: 'foreign',
      name: 'Foreign',
    },
    { id: 'X', productId: 'other', tenantId: 'tenant', name: 'Wrong' },
  ];
  let rows = new Map<string, Row>();
  const row = (id: string, priceCents: number): Row => ({
    id: `price-${id}`,
    variantId: 'variant',
    priceListId: id,
    priceCents,
    tenantId: lists.find((l) => l.id === id)!.tenantId,
    tierPrices: [{ id: `old-${id}`, minQuantity: 3, priceCents: 400 }],
    priceList: {
      id,
      globalPriceList: { name: lists.find((l) => l.id === id)!.name },
    },
  });
  for (const id of ['A', 'C', 'F']) rows.set(id, row(id, 500));
  const record = (name: string) => {
    if (!inside && !allowRoot) throw new Error(`Unexpected root ${name}`);
    events.push(`${inside ? 'tx' : 'root'}:${name}`);
  };
  const netCost = jest.fn(() => cost);
  const product = {
    get purchaseCost() {
      record('enrich');
      return { netCents: netCost() };
    },
  } as Product;
  const repo = {
    findById: jest.fn<Promise<Product | null>, [string]>(() => {
      record('product');
      return Promise.resolve(product);
    }),
  };
  const variant = {
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
        purchaseNetCostCents: override,
      });
    }),
  };
  const findMany = jest.fn(
    ({
      where,
    }: {
      where: { variantId: string; tenantId?: string };
      include: unknown;
      orderBy: unknown;
    }) => {
      record('result');
      return Promise.resolve(
        structuredClone(
          [...rows.values()].filter(
            (r) => !where.tenantId || r.tenantId === where.tenantId,
          ),
        )
          .sort((a, b) =>
            a.priceList.globalPriceList.name.localeCompare(
              b.priceList.globalPriceList.name,
            ),
          )
          .map((r) => ({
            ...r,
            tierPrices: r.tierPrices.sort(
              (a, b) => a.minQuantity - b.minQuantity,
            ),
          })),
      );
    },
  );
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('lifecycle');
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn<Promise<{ id: string }[]>, [Prisma.Sql]>(() => {
      record('gate');
      return Promise.resolve([{ id: 'product' }]);
    }),
    variant,
    priceList: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { id: { in: string[] }; tenantId?: string };
          select: unknown;
        }) => {
          record('lists');
          return Promise.resolve(
            lists
              .filter(
                (l) =>
                  where.id.in.includes(l.id) &&
                  (!where.tenantId || where.tenantId === l.tenantId),
              )
              .reverse(),
          );
        },
      ),
    },
    variantPrice: {
      findMany,
      upsert: jest.fn(
        ({
          create,
          update,
        }: {
          where: unknown;
          create: {
            priceListId: string;
            priceCents: number;
            tenantId: string;
            variantId: string;
          };
          update: { priceCents: number };
        }) => {
          record(`upsert:${create.priceListId}`);
          const value = rows.get(create.priceListId) ?? {
            ...row(create.priceListId, create.priceCents),
            tierPrices: [],
          };
          value.priceCents = update.priceCents;
          rows.set(create.priceListId, value);
          return Promise.resolve({ id: value.id });
        },
      ),
    },
    variantTierPrice: {
      deleteMany: jest.fn(
        ({
          where,
        }: {
          where: { variantPriceId: string; tenantId?: string };
        }) => {
          record('clear');
          const value = [...rows.values()].find(
            (r) => r.id === where.variantPriceId,
          );
          if (value && (!where.tenantId || value.tenantId === where.tenantId))
            value.tierPrices = [];
          return Promise.resolve();
        },
      ),
      createMany: jest.fn(
        ({
          data,
        }: {
          data: Array<{
            variantPriceId: string;
            tenantId: string;
            minQuantity: number;
            priceCents: number;
          }>;
        }) => {
          record('tiers');
          data.forEach((t, i) => {
            const value = [...rows.values()].find(
              (r) => r.id === t.variantPriceId,
            )!;
            value.tierPrices.push({
              id: `tier-${value.priceListId}-${i}`,
              minQuantity: t.minQuantity,
              priceCents: t.priceCents,
            });
          });
          return Promise.resolve();
        },
      ),
    },
  };
  const rootFind = jest.fn(findMany.getMockImplementation());
  const root = { variant, variantPrice: { findMany: rootFind } };
  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    if (inside) return work();
    const before = structuredClone(rows);
    inside = true;
    events.push('begin');
    try {
      const result = await work();
      events.push('commit');
      return result;
    } catch (e) {
      rows = before;
      events.push('rollback');
      throw e;
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
    root as unknown as Args[1],
    {} as Args[2],
    tenant as unknown as Args[3],
    {} as Args[4],
  );
  return {
    tx,
    repo,
    netCost,
    rootFind,
    tenant,
    events,
    transaction,
    bulk: (prices: Item[]) =>
      service.bulkUpsertVariantPrices('product', 'variant', { prices }),
    get: () => {
      allowRoot = true;
      return service.getVariantPrices('product', 'variant');
    },
    lists,
    snapshot: () => structuredClone([...rows.values()]),
    clear: () => rows.clear(),
    costs: (parent: number, child: number | null) => {
      cost = parent;
      override = child;
    },
  };
}
const replacement = [
  { minQuantity: 0, priceCents: 0 },
  { minQuantity: 2, priceCents: 800 },
];
const batch: Item[] = [
  { priceListId: 'A', priceCents: 1000, tierPrices: replacement },
  { priceListId: 'B', priceCents: 700 },
  { priceListId: 'A', priceCents: 900 },
];
function response(rows: Row[], cost: number) {
  const margin = (price: number) => ({
    amountCents: price - cost,
    amountDecimal: (price - cost) / 100,
    percent: price > 0 ? Math.round(((price - cost) / price) * 100) : 0,
  });
  return rows.map((r) => ({
    id: r.id,
    variantId: r.variantId,
    priceListId: r.priceListId,
    priceListName: r.priceList.globalPriceList.name,
    priceCents: r.priceCents,
    priceDecimal: r.priceCents / 100,
    margin: margin(r.priceCents),
    tierPrices: r.tierPrices.map((t) => ({
      ...t,
      priceDecimal: t.priceCents / 100,
      margin: margin(t.priceCents),
    })),
  }));
}
it('gates before every read, validates unique IDs and retains full response inside the transaction', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('tx:gate');
    s.costs(333, null);
    return Promise.resolve([{ id: 'product' }]);
  });
  const result = await s.bulk(batch);
  expect(s.events).toEqual([
    'begin',
    'tx:lifecycle',
    'tx:gate',
    'tx:product',
    'tx:variant',
    'tx:lists',
    'tx:upsert:A',
    'tx:clear',
    'tx:tiers',
    'tx:upsert:B',
    'tx:upsert:A',
    'tx:product',
    'tx:variant',
    'tx:result',
    'tx:enrich',
    'tx:enrich',
    'tx:enrich',
    'commit',
  ]);
  expect(s.tx.$executeRaw).toHaveBeenCalledTimes(1);
  expect(s.tx.$executeRaw.mock.calls[0][0].join('')).toBe(
    'LOCK TABLE "global_price_lists" IN SHARE MODE',
  );
  expect(s.tx.$executeRaw.mock.calls[0]).toHaveLength(1);
  const gate = s.tx.$queryRaw.mock.calls[0][0];
  expect(gate.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT "id" FROM "products" WHERE "tenantId" = ? AND "id" = ? FOR UPDATE',
  );
  expect(gate.values).toEqual(['tenant', 'product']);
  expect(s.tx.priceList.findMany).toHaveBeenCalledWith({
    where: { id: { in: ['A', 'B'] }, tenantId: 'tenant' },
    select: { id: true, productId: true },
  });
  expect(
    s.tx.variantPrice.upsert.mock.calls.map(([q]) => q.create.priceListId),
  ).toEqual(['A', 'B', 'A']);
  expect(s.tx.variantPrice.upsert.mock.calls[0][0]).toEqual({
    where: {
      tenantId_variantId_priceListId: { ...identity, priceListId: 'A' },
    },
    create: { ...identity, priceListId: 'A', priceCents: 1000 },
    update: { priceCents: 1000 },
  });
  expect(s.tx.variantTierPrice.deleteMany).toHaveBeenCalledWith({
    where: { variantPriceId: 'price-A', tenantId: 'tenant' },
  });
  expect(s.tx.variantTierPrice.createMany).toHaveBeenCalledWith({
    data: replacement.map((t) => ({
      ...t,
      variantPriceId: 'price-A',
      tenantId: 'tenant',
    })),
  });
  expect(s.tx.variantPrice.findMany).toHaveBeenCalledWith({
    where: { variantId: 'variant', tenantId: 'tenant' },
    include: {
      priceList: {
        select: { id: true, globalPriceList: { select: { name: true } } },
      },
      tierPrices: { orderBy: { minQuantity: 'asc' } },
    },
    orderBy: { priceList: { globalPriceList: { name: 'asc' } } },
  });
  const stored = s.snapshot();
  expect(stored.find((r) => r.priceListId === 'A')).toMatchObject({
    priceCents: 900,
    tierPrices: replacement.map((t) => expect.objectContaining(t) as unknown),
  });
  expect(stored.find((r) => r.priceListId === 'B')).toMatchObject({
    priceCents: 700,
    tierPrices: [],
  });
  const expected = stored
    .filter((r) => r.tenantId === 'tenant')
    .sort((a, b) => a.priceListId.localeCompare(b.priceListId));
  expect(result).toEqual(response(expected, 333));
  expect(result.map((r) => r.priceListId)).toEqual(['A', 'B', 'C']);
  expect(s.rootFind).not.toHaveBeenCalled();
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
});

it.each([false, true])(
  'empty input returns the complete existing collection, empty=%s',
  async (empty) => {
    const s = setup();
    if (empty) s.clear();
    const before = s.snapshot();
    await expect(s.bulk([])).resolves.toEqual(
      response(
        before.filter((r) => r.tenantId === 'tenant'),
        100,
      ),
    );
    expect(s.events.slice(0, 3)).toEqual(['begin', 'tx:lifecycle', 'tx:gate']);
    expect(s.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(s.repo.findById).toHaveBeenCalledTimes(2);
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);
it.each([null, 0, 700])(
  'preserves PUBLICO, zero prices, all tier transitions and cost=%s',
  async (cost) => {
    for (const first of [undefined, [], replacement])
      for (const last of [undefined, [], replacement]) {
        const s = setup();
        s.costs(333, cost);
        const before = s.snapshot();
        const result = await s.bulk([
          { priceListId: 'C', priceCents: 500, tierPrices: first },
          { priceListId: 'B', priceCents: 700 },
          { priceListId: 'C', priceCents: 0, tierPrices: last },
        ]);
        const expectedTiers =
          last ??
          first ??
          before.find((r) => r.priceListId === 'C')!.tierPrices;
        const stored = s.snapshot();
        expect(
          stored
            .find((r) => r.priceListId === 'C')
            ?.tierPrices.map(({ minQuantity, priceCents }) => ({
              minQuantity,
              priceCents,
            })),
        ).toEqual(
          expectedTiers.map(({ minQuantity, priceCents }) => ({
            minQuantity,
            priceCents,
          })),
        );
        expect(stored.find((r) => r.priceListId === 'C')?.priceCents).toBe(0);
        expect(result).toEqual(
          response(
            stored
              .filter((r) => r.tenantId === 'tenant')
              .sort((a, b) => a.priceListId.localeCompare(b.priceListId)),
            cost ?? 333,
          ),
        );
        expect(stored.find((r) => r.priceListId === 'A')).toEqual(
          before.find((r) => r.priceListId === 'A'),
        );
      }
  },
);
it.each(['gate', 'product', 'variant', 'second-product', 'second-variant'])(
  'rolls back on missing %s',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    if (stage === 'gate') s.tx.$queryRaw.mockResolvedValue([]);
    if (stage === 'product') s.repo.findById.mockResolvedValue(null);
    if (stage === 'variant') s.tx.variant.findFirst.mockResolvedValue(null);
    if (stage === 'second-product')
      s.repo.findById
        .mockImplementationOnce(s.repo.findById.getMockImplementation()!)
        .mockResolvedValueOnce(null);
    if (stage === 'second-variant')
      s.tx.variant.findFirst
        .mockImplementationOnce(s.tx.variant.findFirst.getMockImplementation()!)
        .mockResolvedValueOnce(null);
    const variant = stage.includes('variant');
    await expect(s.bulk(batch)).rejects.toEqual(
      new EntityNotFoundError(
        variant ? 'Variant' : 'Product',
        variant ? 'variant' : 'product',
      ),
    );
    expect(s.snapshot()).toEqual(before);
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.tx.variantPrice.upsert).toHaveBeenCalledTimes(
      stage.startsWith('second') ? 3 : 0,
    );
  },
);
it('retains same-tenant Variant mismatch before list validation', async () => {
  const s = setup();
  const before = s.snapshot();
  s.tx.variant.findFirst.mockResolvedValue({
    id: 'variant',
    productId: 'other',
    purchaseNetCostCents: null,
  });
  await expect(s.bulk(batch)).rejects.toEqual(
    new BusinessRuleViolationError(
      'Variant does not belong to the product',
      'VARIANT_PRODUCT_MISMATCH',
    ),
  );
  expect(s.tx.priceList.findMany).not.toHaveBeenCalled();
  expect(s.snapshot()).toEqual(before);
});
it.each([
  [['X', 'missing-2', 'missing-1', 'missing-2'], 'missing-2'],
  [['F', 'missing-1'], 'F'],
  [['missing-1', 'F'], 'missing-1'],
] as const)(
  'chooses the first requested invisible/missing list before mismatch: %s',
  async (ids: readonly string[], missing: string) => {
    const s = setup();
    const before = s.snapshot();
    await expect(
      s.bulk(
        ids.map((priceListId) => ({
          priceListId,
          priceCents: 0,
          tierPrices: [{ minQuantity: -1, priceCents: 0 }],
        })),
      ),
    ).rejects.toEqual(new EntityNotFoundError('PriceList', missing));
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);
it('checks list ownership before invalid tiers when every list exists', async () => {
  const s = setup();
  const before = s.snapshot();
  await expect(
    s.bulk([
      {
        priceListId: 'A',
        priceCents: 0,
        tierPrices: [{ minQuantity: -1, priceCents: 0 }],
      },
      { priceListId: 'X', priceCents: 0 },
    ]),
  ).rejects.toEqual(
    new BusinessRuleViolationError(
      'Price list does not belong to the product',
      'PRICE_LIST_PRODUCT_MISMATCH',
    ),
  );
  expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
  expect(s.snapshot()).toEqual(before);
});
it.each([
  [[0.5], 'Tier quantity thresholds must be integers >= 0'],
  [[-1], 'Tier quantity thresholds must be >= 0'],
  [[2, 2], 'Tier thresholds must be unique. Duplicate value: 2'],
  [[3, 1], 'Tier thresholds must be strictly ascending and unique: 3 -> 1'],
] as const)(
  'validates later/overwritten items before any mutation: %s',
  async (quantities: readonly number[], message: string) => {
    const s = setup();
    const before = s.snapshot();
    await expect(
      s.bulk([
        { priceListId: 'B', priceCents: 0 },
        {
          priceListId: 'A',
          priceCents: 0,
          tierPrices: quantities.map((minQuantity) => ({
            minQuantity,
            priceCents: 0,
          })),
        },
        { priceListId: 'A', priceCents: 100 },
      ]),
    ).rejects.toEqual(new InvalidArgumentError(message));
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);
it.each([
  'lifecycle',
  'gate',
  'product',
  'variant',
  'lists',
  'upsert',
  'clear',
  'tiers',
  'result',
  'enrich',
])('preserves error identity and every row on %s failure', async (stage) => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('sentinel');
  const methods = {
    lifecycle: s.tx.$executeRaw,
    gate: s.tx.$queryRaw,
    product: s.repo.findById,
    variant: s.tx.variant.findFirst,
    lists: s.tx.priceList.findMany,
    upsert: s.tx.variantPrice.upsert,
    clear: s.tx.variantTierPrice.deleteMany,
    tiers: s.tx.variantTierPrice.createMany,
    result: s.tx.variantPrice.findMany,
  };
  if (stage === 'enrich')
    s.netCost.mockReturnValueOnce(100).mockImplementationOnce(() => {
      throw error;
    });
  else {
    const method = methods[stage as keyof typeof methods];
    method.mockRejectedValueOnce(error);
  }
  await expect(s.bulk(batch)).rejects.toBe(error);
  expect(s.snapshot()).toEqual(before);
  expect(s.events.at(-1)).toBe('rollback');
  if (stage === 'lifecycle') {
    expect(s.events).toEqual(['begin', 'rollback']);
    expect(s.tx.$queryRaw).not.toHaveBeenCalled();
    expect(s.repo.findById).not.toHaveBeenCalled();
    expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
  }
});
it.each(['upsert', 'clear', 'tiers'])(
  'rolls back earlier inserts and updates on a later %s failure',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    const error = new Error('late mutation');
    if (stage === 'upsert')
      s.tx.variantPrice.upsert
        .mockImplementationOnce(
          s.tx.variantPrice.upsert.getMockImplementation()!,
        )
        .mockRejectedValueOnce(error);
    if (stage === 'clear')
      s.tx.variantTierPrice.deleteMany
        .mockImplementationOnce(
          s.tx.variantTierPrice.deleteMany.getMockImplementation()!,
        )
        .mockRejectedValueOnce(error);
    if (stage === 'tiers')
      s.tx.variantTierPrice.createMany
        .mockImplementationOnce(
          s.tx.variantTierPrice.createMany.getMockImplementation()!,
        )
        .mockRejectedValueOnce(error);
    await expect(
      s.bulk([
        { priceListId: 'B', priceCents: 0, tierPrices: replacement },
        { priceListId: 'A', priceCents: 1, tierPrices: replacement },
      ]),
    ).rejects.toBe(error);
    expect(s.snapshot()).toEqual(before);
    expect(s.events.at(-1)).toBe('rollback');
  },
);
it('joins ambient ownership and restores every row on outer failure', async () => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('outer');
  await expect(
    s.transaction(async () => {
      const first = await s.bulk(batch);
      const second = await s.bulk([{ priceListId: 'A', priceCents: 800 }]);
      expect(second).toEqual([
        {
          ...first[0],
          priceCents: 800,
          priceDecimal: 8,
          margin: { amountCents: 700, amountDecimal: 7, percent: 88 },
        },
        ...first.slice(1),
      ]);
      expect(s.tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
        'LOCK TABLE "global_price_lists" IN SHARE MODE',
        'LOCK TABLE "global_price_lists" IN SHARE MODE',
      ]);
      expect(s.events).not.toContain('commit');
      expect(s.snapshot()).not.toEqual(before);
      throw error;
    }),
  ).rejects.toBe(error);
  expect(s.snapshot()).toEqual(before);
  expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
});
it('preserves the ordinary GET root query, complete response and lack of transaction', async () => {
  const s = setup();
  const before = s.snapshot();
  await expect(s.get()).resolves.toEqual(
    response(
      [...before].sort((a, b) =>
        a.priceList.globalPriceList.name.localeCompare(
          b.priceList.globalPriceList.name,
        ),
      ),
      100,
    ),
  );
  expect(s.rootFind.mock.calls[0][0].where).toEqual({ variantId: 'variant' });
  expect(s.rootFind).toHaveBeenCalledTimes(1);
  expect(s.tx.$executeRaw).not.toHaveBeenCalled();
  expect(s.tx.variantPrice.findMany).not.toHaveBeenCalled();
  expect(s.tenant.runInTransaction).not.toHaveBeenCalled();
  expect(s.snapshot()).toEqual(before);
});
it.each([false, true])(
  'waits for lifecycle before any observation, vanished=%s',
  async (vanished) => {
    const s = setup();
    const before = s.snapshot();
    let release!: () => void;
    s.tx.$executeRaw.mockImplementation(() => {
      s.events.push('tx:lifecycle');
      return new Promise<number>((resolve) => (release = () => resolve(0)));
    });
    const pending = s.bulk(batch).then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      expect(s.events).toEqual(['begin', 'tx:lifecycle']);
      expect(s.tx.$queryRaw).not.toHaveBeenCalled();
      expect(s.repo.findById).not.toHaveBeenCalled();
      expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
      expect(s.tx.priceList.findMany).not.toHaveBeenCalled();
      expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
      expect(s.snapshot()).toEqual(before);
      s.costs(333, 200);
      if (vanished)
        s.lists.splice(
          s.lists.findIndex((l) => l.id === 'B'),
          1,
        );
    } finally {
      release?.();
      await pending;
    }
    if (vanished) {
      await expect(pending).resolves.toEqual(
        new EntityNotFoundError('PriceList', 'B'),
      );
      expect(s.tx.variantPrice.upsert).not.toHaveBeenCalled();
      expect(s.snapshot()).toEqual(before);
      expect(s.events.at(-1)).toBe('rollback');
    } else {
      await expect(pending).resolves.toEqual(
        response(
          s
            .snapshot()
            .filter((r) => r.tenantId === 'tenant')
            .sort((a, b) => a.priceListId.localeCompare(b.priceListId)),
          200,
        ),
      );
      expect(s.events.at(-1)).toBe('commit');
    }
  },
);
it('preserves ordinary GET failure identity without starting a transaction', async () => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('GET read');
  s.rootFind.mockRejectedValue(error);
  await expect(s.get()).rejects.toBe(error);
  expect(s.snapshot()).toEqual(before);
  expect(s.tenant.runInTransaction).not.toHaveBeenCalled();
});
