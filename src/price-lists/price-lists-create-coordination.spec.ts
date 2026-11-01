import { ForbiddenException } from '@nestjs/common';
import { PriceListsService } from './price-lists.service';
import {
  EntityAlreadyExistsError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';

type Global = { id: string; name: string; isDefault: boolean };
type Price = {
  id: string;
  productId: string;
  globalPriceListId: string;
  priceCents: number;
  tenantId: string;
};
type VariantPrice = {
  variantId: string;
  priceListId: string;
  priceCents: number;
  tenantId: string;
};
function fixture(context: string | null = 'a') {
  const events: string[] = [];
  let active = false;
  let state = {
    globals: [] as Global[],
    prices: [] as Price[],
    variants: [] as VariantPrice[],
  };
  const products = ['a', 'b'].flatMap((tenantId) => [
    { id: `${tenantId}-simple`, tenantId, hasVariants: false },
    { id: `${tenantId}-variant`, tenantId, hasVariants: true },
    { id: `${tenantId}-other`, tenantId, hasVariants: true },
  ]);
  const variants = products
    .filter((p) => p.hasVariants)
    .map((p) => ({ id: `v-${p.id}`, productId: p.id, tenantId: p.tenantId }));
  function record(event: string) {
    if (!active) throw new Error(`escaped ${event}`);
    events.push(event);
  }
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('gate');
      return Promise.resolve(0);
    }),
    globalPriceList: {
      findUnique: jest.fn(
        ({ where }: { where: { name: string }; select: unknown }) => {
          record('lookup');
          return Promise.resolve(
            state.globals.find((g) => g.name === where.name) ?? null,
          );
        },
      ),
      create: jest.fn(({ data }: { data: { name: string } }) => {
        record('create');
        const row = {
          id: `g-${state.globals.length}`,
          name: data.name,
          isDefault: false,
        };
        state.globals.push(row);
        return Promise.resolve(row);
      }),
    },
    product: {
      findMany: jest.fn(
        ({ where }: { where: { tenantId: string }; select: unknown }) => {
          record('products');
          return Promise.resolve(
            products.filter((p) => p.tenantId === where.tenantId),
          );
        },
      ),
    },
    priceList: {
      createMany: jest.fn(({ data }: { data: Omit<Price, 'id'>[] }) => {
        record('prices');
        state.prices.push(
          ...data.map((p) => ({
            ...p,
            id: `p-${p.globalPriceListId}-${p.productId}`,
          })),
        );
        return Promise.resolve({ count: data.length });
      }),
      findMany: jest.fn(
        ({
          where,
        }: {
          where: {
            productId: { in: string[] };
            globalPriceListId: string;
            tenantId: string;
          };
          select: unknown;
        }) => {
          record('lists');
          return Promise.resolve(
            state.prices.filter(
              (p) =>
                p.tenantId === where.tenantId &&
                p.globalPriceListId === where.globalPriceListId &&
                where.productId.in.includes(p.productId),
            ),
          );
        },
      ),
    },
    variant: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { productId: { in: string[] }; tenantId: string };
          select: unknown;
        }) => {
          record('variants');
          return Promise.resolve(
            variants.filter(
              (v) =>
                v.tenantId === where.tenantId &&
                where.productId.in.includes(v.productId),
            ),
          );
        },
      ),
    },
    variantPrice: {
      createMany: jest.fn(({ data }: { data: VariantPrice[] }) => {
        record('variant prices');
        state.variants.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
  };
  let externalGlobals: Global[] | undefined;
  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    if (active) return work();
    const before = structuredClone(state);
    active = true;
    events.push('begin');
    try {
      const result = await work();
      events.push('commit');
      return result;
    } catch (error) {
      state = before;
      if (externalGlobals) state.globals = structuredClone(externalGlobals);
      events.push('rollback');
      throw error;
    } finally {
      active = false;
    }
  }
  const tenant = {
    getTenantId: () => {
      if (!context) throw new ForbiddenException('Tenant context required');
      return context;
    },
    getClient: () => {
      record('client');
      return tx;
    },
    runInTransaction: jest.fn(transaction),
  };
  const root = {
    globalPriceList: {
      findUnique: jest.fn(() => {
        throw new Error('root lookup');
      }),
    },
    $transaction: jest.fn(() => {
      throw new Error('root transaction');
    }),
  };
  type Args = ConstructorParameters<typeof PriceListsService>;
  const service = new PriceListsService(
    root as unknown as Args[0],
    tenant as unknown as Args[1],
  );
  return {
    service,
    tx,
    root,
    tenant,
    transaction,
    events,
    products,
    variants,
    snapshot: () => structuredClone(state),
    competing: (present: boolean) => {
      state.globals = present
        ? [{ id: 'existing', name: 'VIP', isDefault: false }]
        : [];
      externalGlobals = structuredClone(state.globals);
    },
  };
}

it.each(['a', 'b'])(
  'creates the complete zero-price matrix only for selected tenant %s',
  async (tenantId) => {
    const f = fixture(tenantId);
    const result = await f.service.create({ name: ' VIP ' });
    expect(result).toEqual({ id: 'g-0', name: 'VIP', isDefault: false });
    expect(f.events).toEqual([
      'begin',
      'client',
      'gate',
      'lookup',
      'create',
      'products',
      'prices',
      'variants',
      'lists',
      'variant prices',
      'commit',
    ]);
    expect(f.tx.$executeRaw.mock.calls).toEqual([
      [['LOCK TABLE "global_price_lists" IN SHARE ROW EXCLUSIVE MODE']],
    ]);
    expect(f.tx.globalPriceList.create).toHaveBeenCalledWith({
      data: { name: 'VIP' },
    });
    expect(f.tx.product.findMany).toHaveBeenCalledWith({
      where: { tenantId },
      select: { id: true, hasVariants: true },
    });
    const prices = f.products
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({
        id: `p-g-0-${p.id}`,
        productId: p.id,
        globalPriceListId: 'g-0',
        priceCents: 0,
        tenantId,
      }));
    expect(f.snapshot()).toEqual({
      globals: [result],
      prices,
      variants: prices
        .filter((p) => !p.productId.endsWith('simple'))
        .map((p) => ({
          variantId: `v-${p.productId}`,
          priceListId: p.id,
          priceCents: 0,
          tenantId,
        })),
    });
    expect(f.root.globalPriceList.findUnique).not.toHaveBeenCalled();
    expect(f.root.$transaction).not.toHaveBeenCalled();
  },
);

it.each([null, 'a'])(
  'preserves tenant-before-name validation for context %s',
  async (context) => {
    const f = fixture(context);
    await expect(f.service.create({ name: ' ' })).rejects.toEqual(
      context
        ? new InvalidArgumentError('Price list name cannot be empty')
        : new ForbiddenException('Tenant context required'),
    );
    expect(f.events).toEqual([]);
    expect(f.snapshot()).toEqual({ globals: [], prices: [], variants: [] });
    expect(f.root.globalPriceList.findUnique).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'observes the fresh duplicate state after waiting: present=%s',
  async (present) => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.tx.$executeRaw.mockImplementationOnce(async () => {
      reached();
      await gate;
      return 0;
    });
    const result = f.service.create({ name: 'VIP' }).then(
      (value) => value,
      (error: unknown) => error,
    );
    await Promise.race([entered, result]);
    try {
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(f.tx.globalPriceList.findUnique).not.toHaveBeenCalled();
      expect(f.tx.globalPriceList.create).not.toHaveBeenCalled();
      expect(f.tx.product.findMany).not.toHaveBeenCalled();
      expect(f.tx.priceList.createMany).not.toHaveBeenCalled();
      expect(f.tx.variant.findMany).not.toHaveBeenCalled();
      f.competing(present);
    } finally {
      release();
      await result;
    }
    if (present) {
      await expect(result).resolves.toEqual(
        new EntityAlreadyExistsError('GlobalPriceList', 'VIP'),
      );
      expect(f.tx.globalPriceList.create).not.toHaveBeenCalled();
      expect(f.tx.product.findMany).not.toHaveBeenCalled();
      expect(f.snapshot()).toEqual({
        globals: [{ id: 'existing', name: 'VIP', isDefault: false }],
        prices: [],
        variants: [],
      });
    } else
      await expect(result).resolves.toEqual({
        id: 'g-0',
        name: 'VIP',
        isDefault: false,
      });
  },
);

it.each(['empty', 'simple', 'no variants', 'unmapped'])(
  'preserves matrix branch %s',
  async (mode) => {
    const f = fixture();
    if (mode === 'empty') f.tx.product.findMany.mockResolvedValueOnce([]);
    if (mode === 'simple')
      f.tx.product.findMany.mockResolvedValueOnce([f.products[0]]);
    if (mode === 'no variants') f.tx.variant.findMany.mockResolvedValueOnce([]);
    if (mode === 'unmapped') f.tx.priceList.findMany.mockResolvedValueOnce([]);
    const result = await f.service.create({ name: 'VIP' });
    expect(result).toEqual({ id: 'g-0', name: 'VIP', isDefault: false });
    const expected =
      mode === 'empty'
        ? []
        : mode === 'simple'
          ? [f.products[0]]
          : f.products.filter((p) => p.tenantId === 'a');
    expect(f.snapshot()).toEqual({
      globals: [result],
      prices: expected.map((p) => ({
        id: `p-g-0-${p.id}`,
        productId: p.id,
        globalPriceListId: 'g-0',
        priceCents: 0,
        tenantId: 'a',
      })),
      variants: [],
    });
    expect(f.tx.variantPrice.createMany).not.toHaveBeenCalled();
    if (mode === 'empty' || mode === 'simple')
      expect(f.tx.variant.findMany).not.toHaveBeenCalled();
  },
);

it.each([0, 1, 2, 3, 4, 5, 6, 7])(
  'rolls back every collection and preserves failure identity at stage %s',
  async (stage) => {
    const f = fixture();
    const methods = [
      f.tx.$executeRaw,
      f.tx.globalPriceList.findUnique,
      f.tx.globalPriceList.create,
      f.tx.product.findMany,
      f.tx.priceList.createMany,
      f.tx.variant.findMany,
      f.tx.priceList.findMany,
      f.tx.variantPrice.createMany,
    ];
    const before = f.snapshot();
    const error = new Error(`stage ${stage}`);
    methods[stage].mockImplementationOnce(() => {
      throw error;
    });
    await expect(f.service.create({ name: 'VIP' })).rejects.toBe(error);
    expect(f.snapshot()).toEqual(before);
    for (const later of methods.slice(stage + 1))
      expect(later).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('rollback');
  },
);

it.each([false, true])(
  'retains outer ownership across repeated calls, rollback=%s',
  async (rollback) => {
    const f = fixture();
    const before = f.snapshot();
    const error = new Error('outer abort');
    const operation = f.transaction(async () => {
      expect(await f.service.create({ name: 'One' })).toEqual({
        id: 'g-0',
        name: 'One',
        isDefault: false,
      });
      expect(await f.service.create({ name: 'Two' })).toEqual({
        id: 'g-1',
        name: 'Two',
        isDefault: false,
      });
      expect(f.events).not.toContain('commit');
      if (rollback) throw error;
    });
    if (rollback) {
      await expect(operation).rejects.toBe(error);
      expect(f.snapshot()).toEqual(before);
    } else {
      await expect(operation).resolves.toBeUndefined();
      expect(f.snapshot().globals).toHaveLength(2);
      expect(f.snapshot().prices).toHaveLength(6);
      expect(f.snapshot().variants).toHaveLength(4);
      expect(f.events.filter((event) => event === 'commit')).toHaveLength(1);
    }
    expect(f.root.$transaction).not.toHaveBeenCalled();
  },
);
