import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../shared/domain/domain-error';
import { makeStockJournalStub } from './infrastructure/product-stock-journal.test-support';

function setup() {
  let inside = false;
  let present = true;
  const events: string[] = [];
  const record = (name: string) => {
    if (!inside) throw new Error(`Uncoordinated ${name}`);
    events.push(name);
  };
  const rootAccess = jest.fn(() => {
    throw new Error('Unexpected root access');
  });
  const root = new Proxy({}, { get: rootAccess });
  const repo = {
    findById: jest.fn<Promise<object | null>, [string]>(() => {
      record('product');
      return Promise.resolve({});
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
        Promise<{ id: string; productId: string } | null>,
        [unknown]
      >(() => {
        record('variant');
        return Promise.resolve({ id: 'variant', productId: 'product' });
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
          globalPriceList: { isDefault: false },
        });
      }),
    },
    variantPrice: {
      findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(() => {
        record('price');
        return Promise.resolve(present ? { id: 'price' } : null);
      }),
      delete: jest.fn<Promise<void>, [unknown]>(() => {
        record('delete');
        present = false;
        return Promise.resolve();
      }),
    },
  };
  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    if (inside) return work();
    const before = present;
    inside = true;
    events.push('begin');
    try {
      const result = await work();
      events.push('commit');
      return result;
    } catch (error) {
      present = before;
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
    remove: () => service.removeVariantPrice('product', 'variant', 'list'),
    present: () => present,
  };
}

it('gates before all reads and deletes only the selected tenant price', async () => {
  const s = setup();
  await expect(s.remove()).resolves.toBeUndefined();
  expect(s.events).toEqual([
    'begin',
    'lifecycle',
    'gate',
    'product',
    'variant',
    'list',
    'price',
    'delete',
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
  expect(s.tx.variantPrice.findUnique.mock.calls[0][0]).toMatchObject({
    where: {
      tenantId_variantId_priceListId: {
        tenantId: 'tenant',
        variantId: 'variant',
        priceListId: 'list',
      },
    },
  });
  expect(s.tx.variantPrice.delete).toHaveBeenCalledWith({
    where: {
      id: 'price',
      tenantId: 'tenant',
      variantId: 'variant',
      priceListId: 'list',
    },
  });
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
  expect(s.rootAccess).not.toHaveBeenCalled();
  expect(s.present()).toBe(false);
});

it.each([
  ['gate', 'Product', 'product'],
  ['product', 'Product', 'product'],
  ['variant', 'Variant', 'variant'],
  ['list', 'PriceList', 'list'],
  ['price', 'VariantPrice', 'variant:list'],
])(
  'preserves missing/tenant-invisible %s precedence',
  async (stage, entity, id) => {
    const s = setup();
    if (stage === 'gate') s.tx.$queryRaw.mockResolvedValue([]);
    if (stage === 'product') s.repo.findById.mockResolvedValue(null);
    if (stage === 'variant') s.tx.variant.findFirst.mockResolvedValue(null);
    if (stage === 'list') s.tx.priceList.findUnique.mockResolvedValue(null);
    if (stage === 'price') s.tx.variantPrice.findUnique.mockResolvedValue(null);
    await expect(s.remove()).rejects.toEqual(
      new EntityNotFoundError(entity, id),
    );
    expect(s.tx.variantPrice.delete).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.present()).toBe(true);
    expect(s.rootAccess).not.toHaveBeenCalled();
  },
);

it.each(['variant', 'list', 'default'])(
  'preserves %s business protection before deletion',
  async (stage) => {
    const s = setup();
    if (stage === 'variant')
      s.tx.variant.findFirst.mockResolvedValue({
        id: 'variant',
        productId: 'other',
      });
    else
      s.tx.priceList.findUnique.mockResolvedValue({
        id: 'list',
        productId: stage === 'list' ? 'other' : 'product',
        globalPriceList: { isDefault: stage === 'default' },
      });
    const error =
      stage === 'variant'
        ? new BusinessRuleViolationError(
            'Variant does not belong to the product',
            'VARIANT_PRODUCT_MISMATCH',
          )
        : stage === 'list'
          ? new BusinessRuleViolationError(
              'Price list does not belong to the product',
              'PRICE_LIST_PRODUCT_MISMATCH',
            )
          : new BusinessRuleViolationError(
              'Cannot delete the default PUBLICO price list',
              'DEFAULT_PRICE_LIST_PROTECTED',
            );
    await expect(s.remove()).rejects.toEqual(error);
    expect(s.tx.variantPrice.findUnique).not.toHaveBeenCalled();
    expect(s.tx.variantPrice.delete).not.toHaveBeenCalled();
    expect(s.present()).toBe(true);
  },
);

it.each(['lifecycle', 'gate', 'product', 'variant', 'list', 'price', 'delete'])(
  'propagates %s failure without committed mutation',
  async (stage) => {
    const s = setup();
    const error = new Error('sentinel');
    const methods = {
      lifecycle: s.tx.$executeRaw,
      gate: s.tx.$queryRaw,
      product: s.repo.findById,
      variant: s.tx.variant.findFirst,
      list: s.tx.priceList.findUnique,
      price: s.tx.variantPrice.findUnique,
      delete: s.tx.variantPrice.delete,
    };
    methods[stage as keyof typeof methods].mockRejectedValue(error);
    await expect(s.remove()).rejects.toBe(error);
    if (stage === 'lifecycle') {
      expect(s.events).toEqual(['begin', 'rollback']);
      expect(s.tx.$queryRaw).not.toHaveBeenCalled();
      expect(s.repo.findById).not.toHaveBeenCalled();
      expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
      expect(s.tx.priceList.findUnique).not.toHaveBeenCalled();
      expect(s.tx.variantPrice.findUnique).not.toHaveBeenCalled();
      expect(s.tx.variantPrice.delete).not.toHaveBeenCalled();
    }
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.events).not.toContain('commit');
    expect(s.present()).toBe(true);
  },
);

it('joins ambient ownership and restores deletion after a late failure', async () => {
  const s = setup();
  const error = new Error('late failure');
  await expect(
    s.transaction(async () => {
      await s.remove();
      expect(s.present()).toBe(false);
      throw error;
    }),
  ).rejects.toBe(error);
  expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
  expect(s.events.at(-1)).toBe('rollback');
  expect(s.present()).toBe(true);
  expect(s.tenant.runInTransaction).toHaveBeenCalledWith(expect.any(Function));
});

it('uses disappearance observed after the gate rather than a prior snapshot', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('gate');
    s.tx.variantPrice.findUnique.mockResolvedValue(null);
    return Promise.resolve([{ id: 'product' }]);
  });
  await expect(s.remove()).rejects.toEqual(
    new EntityNotFoundError('VariantPrice', 'variant:list'),
  );
  expect(s.events.indexOf('gate')).toBeLessThan(s.events.indexOf('product'));
  expect(s.tx.variantPrice.delete).not.toHaveBeenCalled();
  expect(s.present()).toBe(true);
});

it('awaits lifecycle before all reads and observes a list removed during the wait', async () => {
  const s = setup();
  let release!: () => void;
  const gate = new Promise<number>((resolve) => (release = () => resolve(0)));
  s.tx.$executeRaw.mockImplementation(() => {
    s.events.push('lifecycle');
    return gate;
  });
  const result = s.remove().then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await Promise.resolve();
    expect(s.events).toEqual(['begin', 'lifecycle']);
    expect(s.tx.$queryRaw).not.toHaveBeenCalled();
    expect(s.repo.findById).not.toHaveBeenCalled();
    expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
    expect(s.tx.priceList.findUnique).not.toHaveBeenCalled();
    expect(s.tx.variantPrice.findUnique).not.toHaveBeenCalled();
    expect(s.tx.variantPrice.delete).not.toHaveBeenCalled();
    expect(s.present()).toBe(true);
    s.tx.priceList.findUnique.mockResolvedValue(null);
  } finally {
    release();
    await result;
  }
  await expect(result).resolves.toEqual(
    new EntityNotFoundError('PriceList', 'list'),
  );
  expect(s.tx.variantPrice.findUnique).not.toHaveBeenCalled();
  expect(s.present()).toBe(true);
  expect(s.rootAccess).not.toHaveBeenCalled();
});

it('reacquires shared mode inside the same outer owner without committing', async () => {
  const s = setup();
  await s.transaction(async () => {
    await expect(s.remove()).resolves.toBeUndefined();
    await expect(s.remove()).rejects.toEqual(
      new EntityNotFoundError('VariantPrice', 'variant:list'),
    );
    expect(s.events).not.toContain('commit');
    expect(s.tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
      'LOCK TABLE "global_price_lists" IN SHARE MODE',
      'LOCK TABLE "global_price_lists" IN SHARE MODE',
    ]);
  });
  expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
  expect(s.events.filter((e) => e === 'commit')).toHaveLength(1);
  expect(s.tx.variantPrice.delete).toHaveBeenCalledTimes(1);
  expect(s.present()).toBe(false);
  expect(s.rootAccess).not.toHaveBeenCalled();
});
