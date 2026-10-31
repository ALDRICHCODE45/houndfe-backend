import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
import type { Product } from './domain/product.entity';
import { EntityNotFoundError } from '../shared/domain/domain-error';

const tenantId = 'tenant';
const productId = 'product';
const listId = 'list';
type Tier = { minQuantity: number; priceCents: number };
function setup() {
  let inside = false;
  let cost = 100;
  const events: string[] = [];
  const record = (name: string) =>
    events.push(`${inside ? 'tx' : 'root'}:${name}`);
  const product = {
    get purchaseCost() {
      record('cost');
      return { netCents: cost };
    },
  } as Product;
  const stored = {
    id: listId,
    productId,
    priceCents: 1000,
    globalPriceList: { name: 'Retail' },
    tierPrices: [{ id: 'old', minQuantity: 3, priceCents: 900 }],
  };
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
    $queryRaw: jest.fn<Promise<{ id: string }[]>, [Prisma.Sql]>(() => {
      record('gate');
      return Promise.resolve([{ id: productId }]);
    }),
    priceList: {
      findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>(() => {
        record('list');
        return Promise.resolve({ id: listId });
      }),
      update: jest.fn(
        ({
          data,
        }: {
          where: object;
          data: {
            priceCents?: number;
            tierPrices?: { deleteMany: object; create: Tier[] };
          };
          include: object;
        }) => {
          record('update');
          return Promise.resolve({
            ...stored,
            priceCents: data.priceCents ?? stored.priceCents,
            tierPrices: data.tierPrices
              ? data.tierPrices.create.map((t, i) => ({
                  id: `tier-${i}`,
                  ...t,
                }))
              : stored.tierPrices,
          });
        },
      ),
    },
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: () => (inside ? tx : root),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      events.push('begin');
      inside = true;
      try {
        const result = await work();
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      } finally {
        inside = false;
      }
    }),
  };
  type Args = ConstructorParameters<typeof ProductsService>;
  const service = new ProductsService(
    repo as unknown as Args[0],
    root as Args[1],
    {} as Args[2],
    tenant as unknown as Args[3],
    {} as Args[4],
  );
  return {
    service,
    repo,
    tx,
    tenant,
    rootAccess,
    events,
    stored,
    setCost: (value: number) => {
      cost = value;
    },
  };
}

it('gates before every read and keeps mutation and enrichment in the ambient boundary', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('tx:gate');
    s.setCost(250);
    return Promise.resolve([{ id: productId }]);
  });
  const result = await s.service.updatePriceList(productId, listId, {
    priceCents: 1000,
  });
  expect(s.events).toEqual([
    'begin',
    'tx:gate',
    'tx:product',
    'tx:list',
    'tx:update',
    'tx:cost',
    'commit',
  ]);
  const query = s.tx.$queryRaw.mock.calls[0][0];
  expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT "id" FROM "products" WHERE "tenantId" = ? AND "id" = ? FOR UPDATE',
  );
  expect(query.values).toEqual([tenantId, productId]);
  expect(s.repo.findById).toHaveBeenCalledWith(productId);
  expect(s.tx.priceList.findFirst).toHaveBeenCalledWith({
    where: { id: listId, productId, tenantId },
  });
  expect(s.tx.priceList.update.mock.calls[0][0].where).toEqual({
    id: listId,
    productId,
    tenantId,
  });
  expect(result.margin).toEqual({
    amountCents: 750,
    amountDecimal: 7.5,
    percent: 75,
  });
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
  expect(s.tenant.runInTransaction).toHaveBeenCalledTimes(1);
  expect(s.rootAccess).not.toHaveBeenCalled();
});

it.each(['gate', 'product', 'list', 'wrong-product', 'foreign-tenant'])(
  'preserves not-found precedence for %s',
  async (absent) => {
    const s = setup();
    if (absent === 'gate' || absent === 'foreign-tenant')
      s.tx.$queryRaw.mockResolvedValue([]);
    else if (absent === 'product') s.repo.findById.mockResolvedValue(null);
    else s.tx.priceList.findFirst.mockResolvedValue(null);
    const productMissing = ['gate', 'product', 'foreign-tenant'].includes(
      absent,
    );
    await expect(
      s.service.updatePriceList(productId, listId, {
        tierPrices: [{ minQuantity: -1, priceCents: 1 }],
      }),
    ).rejects.toEqual(
      new EntityNotFoundError(
        productMissing ? 'Product' : 'PriceList',
        productMissing ? productId : listId,
      ),
    );
    expect(s.tx.$queryRaw.mock.calls[0][0].values).toEqual([
      tenantId,
      productId,
    ]);
    if (productMissing) expect(s.tx.priceList.findFirst).not.toHaveBeenCalled();
    else
      expect(s.tx.priceList.findFirst).toHaveBeenCalledWith({
        where: { id: listId, productId, tenantId },
      });
    expect(s.tx.priceList.update).not.toHaveBeenCalled();
    expect(s.rootAccess).not.toHaveBeenCalled();
  },
);

it.each(['gate', 'product', 'list', 'update'] as const)(
  'propagates %s failures without later mutation',
  async (stage) => {
    const s = setup();
    const error = new Error('sentinel');
    const method = {
      gate: s.tx.$queryRaw,
      product: s.repo.findById,
      list: s.tx.priceList.findFirst,
      update: s.tx.priceList.update,
    }[stage];
    method.mockRejectedValue(error);
    await expect(
      s.service.updatePriceList(productId, listId, { priceCents: 0 }),
    ).rejects.toBe(error);
    expect(s.tx.priceList.update).toHaveBeenCalledTimes(
      stage === 'update' ? 1 : 0,
    );
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.events).not.toContain('commit');
    expect(s.stored.priceCents).toBe(1000);
  },
);

it.each([
  {
    quantities: [0.5],
    message: 'Tier quantity thresholds must be integers >= 0',
  },
  { quantities: [-1], message: 'Tier quantity thresholds must be >= 0' },
  {
    quantities: [2, 2],
    message: 'Tier thresholds must be unique. Duplicate value: 2',
  },
  {
    quantities: [3, 1],
    message: 'Tier thresholds must be strictly ascending and unique: 3 -> 1',
  },
])('retains tier validation: $message', async ({ quantities, message }) => {
  const s = setup();
  await expect(
    s.service.updatePriceList(productId, listId, {
      tierPrices: quantities.map((minQuantity) => ({
        minQuantity,
        priceCents: 100,
      })),
    }),
  ).rejects.toThrow(message);
  expect(s.events).toEqual([
    'begin',
    'tx:gate',
    'tx:product',
    'tx:list',
    'rollback',
  ]);
  expect(s.tx.priceList.update).not.toHaveBeenCalled();
  expect(s.stored.tierPrices).toEqual([
    { id: 'old', minQuantity: 3, priceCents: 900 },
  ]);
});

it.each([undefined, 0, 1500])(
  'preserves price %p with omitted, empty and replaced tiers',
  async (priceCents) => {
    for (const tierPrices of [
      undefined,
      [],
      [
        { minQuantity: 0, priceCents: 0 },
        { minQuantity: 5, priceCents: 500 },
      ],
    ]) {
      const s = setup();
      const result = await s.service.updatePriceList(productId, listId, {
        priceCents,
        tierPrices,
      });
      const amount = priceCents ?? 1000;
      expect(result).toMatchObject({
        id: listId,
        productId,
        name: 'Retail',
        priceCents: amount,
        priceDecimal: amount / 100,
        margin: {
          amountCents: amount - 100,
          amountDecimal: (amount - 100) / 100,
          percent: amount > 0 ? Math.round(((amount - 100) / amount) * 100) : 0,
        },
      });
      const command = s.tx.priceList.update.mock.calls[0][0];
      expect(command.include).toEqual({
        tierPrices: { orderBy: { minQuantity: 'asc' } },
        globalPriceList: { select: { name: true } },
      });
      expect(command.data).toEqual({
        ...(priceCents === undefined ? {} : { priceCents }),
        ...(tierPrices === undefined
          ? {}
          : {
              tierPrices: {
                deleteMany: {},
                create: tierPrices.map((t) => ({ ...t, tenantId })),
              },
            }),
      });
      const expectedTiers = tierPrices ?? s.stored.tierPrices;
      expect(result.tierPrices).toHaveLength(expectedTiers.length);
      result.tierPrices.forEach((tier, i) => {
        const price = expectedTiers[i].priceCents;
        expect(tier).toMatchObject({
          minQuantity: expectedTiers[i].minQuantity,
          priceCents: price,
          priceDecimal: price / 100,
          margin: {
            amountCents: price - 100,
            amountDecimal: (price - 100) / 100,
            percent: price > 0 ? Math.round(((price - 100) / price) * 100) : 0,
          },
        });
      });
      expect(s.rootAccess).not.toHaveBeenCalled();
    }
  },
);
