import { Prisma } from '@prisma/client';
import { EntityNotFoundError } from '../shared/domain/domain-error';
import { Product } from './domain/product.entity';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { ProductsService } from './products.service';
import type { UpdateProductDto } from './dto/update-product.dto';
import { makeStockJournalStub } from './infrastructure/product-stock-journal.test-support';

const tenantId = 'tenant';
const productId = 'product';
const listId = '550e8400-e29b-41d4-a716-446655440000';
type Row = Record<string, unknown>;
function fixture(flags: Row = {}) {
  const events: string[] = [];
  const outside: string[] = [];
  let active = false;
  let physical = 0;
  let committed = {
    product: {
      ...Product.create({ id: productId, name: 'Old' }).toPersistence(),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      ...flags,
    },
    joins: ['retained'],
    price: 100,
    minimum: 5,
    rearmed: false,
    detail: null as { capacity: number | null; notes: string | null } | null,
  };
  let working = committed;
  const row = () => ({
    ...working.product,
    serviceDetail: working.detail,
    catalogPriceLists: working.joins.map((globalPriceListId) => ({
      globalPriceListId,
    })),
  });
  const record = (name: string) => {
    events.push(name);
    if (!active) outside.push(name);
  };
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('lifecycle');
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn<
      Promise<Row[]>,
      [Prisma.Sql | TemplateStringsArray, ...unknown[]]
    >((sql) => {
      const text = 'sql' in sql ? sql.sql : sql.join('?');
      const values = 'values' in sql && !Array.isArray(sql) ? sql.values : [];
      if (text.includes('"tenants"')) {
        record('tenant gate');
        expect(values).toEqual([tenantId]);
        expect(text).toContain('FOR SHARE');
        return Promise.resolve([{ id: tenantId }]);
      }
      if (text.includes('FOR UPDATE')) {
        record('product gate');
        expect(values).toEqual([tenantId, productId]);
        expect(text).toContain('"tenantId"');
        return Promise.resolve([{ id: productId }]);
      }
      record('rearm read');
      return Promise.resolve([
        {
          q: working.product.quantity,
          m: working.product.minQuantity,
          useStock: working.product.useStock,
        },
      ]);
    }),
    product: {
      findUnique: jest.fn(
        ({ where, select }: { where: { id: string }; select?: unknown }) => {
          record(select ? 'relations' : 'product read');
          expect(where.id).toBe(productId);
          return Promise.resolve(
            select ? { category: null, brand: null } : row(),
          );
        },
      ),
      upsert: jest.fn(({ update }: { update: Row }) => {
        record('save');
        working.product = { ...working.product, ...update };
        return Promise.resolve(row());
      }),
    },
    tenantCatalogPriceList: {
      findMany: jest.fn(({ where }: { where: { tenantId: string } }) => {
        record('bindings');
        expect(where.tenantId).toBe(tenantId);
        return Promise.resolve([{ globalPriceListId: listId }]);
      }),
    },
    productCatalogPriceList: {
      deleteMany: jest.fn(
        ({ where }: { where: { tenantId: string; productId: string } }) => {
          record('delete joins');
          expect(where).toEqual({ tenantId, productId });
          working.joins = [];
          return Promise.resolve({ count: 0 });
        },
      ),
      createMany: jest.fn(
        ({
          data,
        }: {
          data: {
            tenantId: string;
            productId: string;
            globalPriceListId: string;
          }[];
        }) => {
          record('create joins');
          for (const item of data)
            expect(item).toMatchObject({ tenantId, productId });
          working.joins = data.map((item) => item.globalPriceListId);
          return Promise.resolve({ count: data.length });
        },
      ),
    },
    globalPriceList: {
      findFirst: jest.fn(() => {
        record('default');
        return Promise.resolve({ id: listId });
      }),
    },
    priceList: {
      updateMany: jest.fn(
        ({
          data,
          where,
        }: {
          data: { priceCents: number };
          where: { globalPriceListId: string };
        }) => {
          record('price write');
          expect(where.globalPriceListId).toBe(listId);
          working.price = data.priceCents;
          return Promise.resolve({ count: 1 });
        },
      ),
      findMany: jest.fn(() => {
        record('prices response');
        return Promise.resolve([
          {
            id: 'price',
            priceCents: working.price,
            tierPrices: [],
            globalPriceList: { name: 'PUBLICO', isDefault: true },
          },
        ]);
      }),
    },
    variant: {
      updateMany: jest.fn(() => {
        record('cascade');
        working.minimum = 0;
        return Promise.resolve({ count: 1 });
      }),
      count: jest.fn(() => {
        record('membership');
        return Promise.resolve(0);
      }),
      findMany: jest.fn(() => {
        record('variants response');
        return Promise.resolve([] as Row[]);
      }),
    },
    lot: {
      findMany: jest.fn(() => {
        record('lots response');
        return Promise.resolve([]);
      }),
      count: jest.fn(() => Promise.resolve(0)),
    },
    productImage: {
      findMany: jest.fn(() => {
        record('images response');
        return Promise.resolve([]);
      }),
    },
    serviceDetail: {
      deleteMany: jest.fn(() => {
        record('detail delete');
        working.detail = null;
        return Promise.resolve({ count: 0 });
      }),
      upsert: jest.fn(({ update }: { update: typeof working.detail }) => {
        record('detail upsert');
        working.detail = update;
        return Promise.resolve(update);
      }),
    },
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active) return work();
    physical++;
    active = true;
    working = structuredClone(committed);
    events.push('begin');
    try {
      const result = await work();
      committed = working;
      events.push('commit');
      return result;
    } catch (error) {
      events.push('rollback');
      throw error;
    } finally {
      active = false;
      working = committed;
    }
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: () => tx,
    isInTransaction: () => active,
    runInTransaction: run,
  };
  const rearm = jest.fn(() => {
    record('rearm');
    working.rearmed = true;
    return Promise.resolve();
  });
  // SAFETY: the real repository consumes these instrumented delegate/alert surfaces only.
  const repo = new PrismaProductRepository(
    tenant as never,
    { publish: jest.fn() } as never,
    { rearm, seedAndFlip: jest.fn() } as never,
  );
  const rootDefault = jest.fn(() => {
    record('root default');
    return Promise.resolve({ id: 'stale' });
  });
  const service = new ProductsService(
    repo,
    { globalPriceList: { findFirst: rootDefault } } as never,
    {} as never,
    tenant as never,
    { assertExists: jest.fn() } as never,
    makeStockJournalStub(),
  );
  const update = (
    dto: UpdateProductDto = {
      name: 'New',
      priceCents: 0,
      supportedCatalogPriceListIds: [listId],
    },
  ) => service.update(productId, dto);
  return {
    tx,
    events,
    outside,
    update,
    run,
    rootDefault,
    rearm,
    snapshot: () => structuredClone(committed),
    physical: () => physical,
    active: () => active,
    concurrent: () => {
      working.product.includeInOnlineCatalog = true;
      working.joins = [listId];
    },
  };
}

it('coordinates mixed writes and the real full response in one physical transaction', async () => {
  const f = fixture();
  const response = await f.update({
    name: 'New',
    priceCents: 0,
    supportedCatalogPriceListIds: [listId],
    useStock: false,
  });
  expect(f.events.slice(0, 5)).toEqual([
    'begin',
    'lifecycle',
    'tenant gate',
    'product gate',
    'product read',
  ]);
  expect(f.tx.$executeRaw.mock.calls).toEqual([
    [['LOCK TABLE "global_price_lists" IN SHARE MODE']],
  ]);
  expect(f.events.at(-1)).toBe('commit');
  expect(f.outside).toEqual([]);
  expect(f.rootDefault).not.toHaveBeenCalled();
  expect(f.physical()).toBe(1);
  expect(f.active()).toBe(false);
  expect(f.snapshot()).toMatchObject({
    product: { name: 'New', useStock: false },
    joins: [listId],
    price: 0,
    minimum: 0,
  });
  expect(response).toMatchObject({
    name: 'New',
    priceCents: 0,
    supportedCatalogPriceListIds: [listId],
    supportsAllCatalogPriceLists: false,
    images: [],
    lots: [],
    variants: [],
  });
});

it.each(['lifecycle', 'tenant', 'product'])(
  'waits for %s before loading and preserves newly committed omitted fields',
  async (gateName) => {
    const f = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (gateName === 'lifecycle')
      f.tx.$executeRaw.mockImplementationOnce(async () => {
        enter();
        await gate;
        return 0;
      });
    else {
      if (gateName === 'product')
        f.tx.$queryRaw.mockResolvedValueOnce([{ id: tenantId }]);
      f.tx.$queryRaw.mockImplementationOnce(async () => {
        enter();
        await gate;
        return [{ id: productId }];
      });
    }
    const operation = f.update({ name: 'Fresh' });
    await Promise.race([
      entered,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    try {
      expect(f.tx.product.findUnique).not.toHaveBeenCalled();
      expect(f.tx.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
      expect(f.tx.globalPriceList.findFirst).not.toHaveBeenCalled();
      f.concurrent();
    } finally {
      release();
      await operation.catch(() => undefined);
    }
    await expect(operation).resolves.toMatchObject({
      name: 'Fresh',
      includeInOnlineCatalog: true,
      supportedCatalogPriceListIds: [listId],
    });
    expect(f.snapshot()).toMatchObject({
      product: { name: 'Fresh', includeInOnlineCatalog: true },
      joins: [listId],
    });
  },
);

it.each(['lifecycle', 'tenant', 'product'])(
  'propagates %s gate failure before reads or writes',
  async (gateName) => {
    const f = fixture();
    const before = f.snapshot();
    const error = new Error(gateName);
    if (gateName === 'lifecycle') f.tx.$executeRaw.mockRejectedValueOnce(error);
    else {
      if (gateName === 'product')
        f.tx.$queryRaw.mockResolvedValueOnce([{ id: tenantId }]);
      f.tx.$queryRaw.mockRejectedValueOnce(error);
    }
    await expect(f.update()).rejects.toBe(error);
    expect(f.snapshot()).toEqual(before);
    expect(f.tx.product.findUnique).not.toHaveBeenCalled();
    expect(f.tx.product.upsert).not.toHaveBeenCalled();
    expect(f.active()).toBe(false);
  },
);

it.each(['tenant', 'product'])(
  'denies an unavailable %s without an unqualified aggregate read',
  async (target) => {
    const f = fixture();
    if (target === 'product')
      f.tx.$queryRaw.mockResolvedValueOnce([{ id: tenantId }]);
    f.tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(f.update()).rejects.toMatchObject(
      new EntityNotFoundError('Product', productId),
    );
    expect(f.tx.product.findUnique).not.toHaveBeenCalled();
    expect(f.tx.product.upsert).not.toHaveBeenCalled();
  },
);

it.each([
  'bindings',
  'default',
  'save',
  'joins',
  'cascade',
  'detail',
  'relations',
  'prices',
  'images',
  'enrichment',
])(
  'rolls back mixed effects when %s fails, retaining the error identity',
  async (stage) => {
    const f = fixture();
    const before = f.snapshot();
    const error = new Error(stage);
    const fail = () => Promise.reject(error);
    if (stage === 'bindings')
      f.tx.tenantCatalogPriceList.findMany.mockImplementationOnce(fail);
    if (stage === 'default')
      f.tx.globalPriceList.findFirst.mockImplementationOnce(fail);
    if (stage === 'save') f.tx.product.upsert.mockImplementationOnce(fail);
    if (stage === 'joins')
      f.tx.productCatalogPriceList.createMany.mockImplementationOnce(fail);
    if (stage === 'cascade')
      f.tx.variant.updateMany.mockImplementationOnce(fail);
    if (stage === 'detail')
      f.tx.serviceDetail.deleteMany.mockImplementationOnce(fail);
    if (stage === 'relations') {
      const original = f.tx.product.findUnique.getMockImplementation()!;
      f.tx.product.findUnique.mockImplementation((args) =>
        args.select ? fail() : original(args),
      );
    }
    if (stage === 'prices')
      f.tx.priceList.findMany.mockImplementationOnce(fail);
    if (stage === 'images')
      f.tx.productImage.findMany.mockImplementationOnce(fail);
    if (stage === 'enrichment')
      f.tx.priceList.findMany.mockResolvedValueOnce([
        {
          id: 'price',
          priceCents: 0,
          get tierPrices(): never {
            throw error;
          },
          globalPriceList: { name: 'PUBLICO', isDefault: true },
        },
      ]);
    await expect(
      f.update({
        name: 'New',
        priceCents: 0,
        supportedCatalogPriceListIds: [listId],
        useStock: false,
      }),
    ).rejects.toBe(error);
    expect(f.snapshot()).toEqual(before);
    expect(f.events.at(-1)).toBe('rollback');
    expect(f.active()).toBe(false);
  },
);

it.each([false, true])(
  'keeps repeated updates under outer ownership, rollback=%s',
  async (rollback) => {
    const f = fixture();
    const before = f.snapshot();
    const error = new Error('outer');
    const operation = f.run(async () => {
      await f.update({ name: 'First' });
      await f.update({
        description: 'Second',
        supportedCatalogPriceListIds: [],
      });
      expect(f.snapshot()).toEqual(before);
      expect(f.active()).toBe(true);
      expect(f.events).not.toContain('commit');
      if (rollback) throw error;
    });
    if (rollback) {
      await expect(operation).rejects.toBe(error);
      expect(f.snapshot()).toEqual(before);
    } else {
      await operation;
      expect(f.snapshot()).toMatchObject({
        product: { name: 'First', description: 'Second' },
        joins: [],
      });
    }
    expect(f.physical()).toBe(1);
    expect(f.active()).toBe(false);
    expect(f.outside).toEqual([]);
  },
);

it.each(['variants', 'lots'])(
  'keeps the real %s response read inside the transaction and rolls back its failure',
  async (branch) => {
    const f = fixture(
      branch === 'variants'
        ? { hasVariants: true }
        : { useLotsAndExpirations: true, useStock: true },
    );
    const before = f.snapshot();
    const error = new Error(branch);
    if (branch === 'variants')
      f.tx.variant.findMany.mockRejectedValueOnce(error);
    else f.tx.lot.findMany.mockRejectedValueOnce(error);
    await expect(f.update({ name: 'New' })).rejects.toBe(error);
    expect(f.snapshot()).toEqual(before);
    expect(f.outside).toEqual([]);
    expect(f.active()).toBe(false);
  },
);

it('restores service detail and stock-alert effects on outer rollback', async () => {
  const f = fixture({ type: 'SERVICE', useStock: false });
  const before = f.snapshot();
  const error = new Error('outer');
  await expect(
    f.run(async () => {
      await f.update({ serviceDetail: { capacity: 7, notes: 'Changed' } });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(f.tx.serviceDetail.upsert).toHaveBeenCalled();
  expect(f.snapshot()).toEqual(before);
  const stock = fixture({ quantity: 10, minQuantity: 5, useStock: true });
  const stockBefore = stock.snapshot();
  await expect(
    stock.run(async () => {
      await stock.update({ minQuantity: 2 });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(stock.rearm).toHaveBeenCalled();
  expect(stock.snapshot()).toEqual(stockBefore);
});

it('materializes real variant enrichment and stock totals before completion', async () => {
  const f = fixture({ hasVariants: true });
  const variant = {
    id: 'variant',
    productId,
    name: 'Variant',
    sku: null,
    barcode: null,
    quantity: 4,
    minQuantity: 2,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    images: [],
    variantPrices: [],
  };
  f.tx.variant.findMany.mockResolvedValueOnce([variant]);
  const response = await f.update({ name: 'New' });
  expect(response).toMatchObject({
    variantCount: 1,
    variantStockTotal: 4,
    variants: [
      {
        id: 'variant',
        minQuantity: 2,
        catalogPublishMode: 'INHERIT',
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: null,
        variantPrices: [],
      },
    ],
  });
  expect(f.outside).toEqual([]);
  expect(f.events.at(-1)).toBe('commit');
});

it('rejects a requested binding removed while waiting without saving an earlier observation', async () => {
  const f = fixture();
  const before = f.snapshot();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.tx.$queryRaw.mockImplementationOnce(async () => {
    enter();
    await gate;
    return [{ id: tenantId }];
  });
  const operation = f.update().catch((error: unknown) => error);
  await entered;
  try {
    expect(f.tx.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
    f.tx.tenantCatalogPriceList.findMany.mockResolvedValueOnce([]);
  } finally {
    release();
  }
  await expect(operation).resolves.toMatchObject({
    code: 'INVALID_ARGUMENT',
    message: 'Catalog price list selection is invalid',
  });
  expect(f.tx.product.upsert).not.toHaveBeenCalled();
  expect(f.snapshot()).toEqual(before);
  expect(f.active()).toBe(false);
});
