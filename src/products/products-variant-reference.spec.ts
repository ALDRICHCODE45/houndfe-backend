import { ProductsService } from './products.service';
import { Product } from './domain/product.entity';
import type { IProductRepository } from './domain/product.repository';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { FilesService } from '../files/files.service';
import type { SatCatalogService } from '../sat-catalog/sat-catalog.service';

const productId = 'product-1';
const tenantId = 'tenant-1';

function fixture() {
  const events: string[] = [];
  const initial = {
    variants: [] as Record<string, unknown>[],
    prices: [] as Record<string, unknown>[],
    flags: {} as Record<string, unknown>,
  };
  let persisted = structuredClone(initial);
  let pending = structuredClone(initial);
  let active = false;
  let locked = false;
  const root = {
    $transaction: jest.fn(() => Promise.reject(new Error('root'))),
  };
  const tx = {
    $executeRaw: jest.fn(() => {
      events.push('lifecycle');
      expect(active).toBe(true);
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn(() => {
      events.push('gate');
      locked = true;
      return Promise.resolve([{ id: productId }]);
    }),
    variant: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        events.push('insert');
        const row = { id: `variant-${pending.variants.length + 1}`, ...data };
        pending.variants.push(row);
        return Promise.resolve(row);
      }),
    },
    priceList: {
      findMany: jest.fn(() => {
        events.push('lists');
        return Promise.resolve([{ id: 'price-1' }, { id: 'price-2' }]);
      }),
    },
    variantPrice: {
      createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
        events.push('prices');
        pending.prices.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    product: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        events.push('flags');
        pending.flags = data;
        return Promise.resolve(data);
      }),
    },
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: jest.fn(() => (active ? tx : root)),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      if (active) return work();
      active = true;
      locked = false;
      pending = structuredClone(persisted);
      try {
        const result = await work();
        persisted = structuredClone(pending);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      } finally {
        active = false;
      }
    }),
  };
  const product = Product.create({
    id: productId,
    name: 'Parent',
    useStock: true,
  });
  const repo = {
    findById: jest.fn(() => {
      events.push('read');
      expect(active).toBe(true);
      expect(locked).toBe(true);
      expect(tenant.getClient()).toBe(tx);
      return Promise.resolve(product as Product | null);
    }),
    isSkuTaken: jest.fn(() => {
      expect(tenant.getClient()).toBe(tx);
      return Promise.resolve(false);
    }),
    isBarcodeTaken: jest.fn(() => {
      expect(tenant.getClient()).toBe(tx);
      return Promise.resolve(false);
    }),
  };
  const service = new ProductsService(
    repo as unknown as IProductRepository,
    root as unknown as PrismaService,
    {} as FilesService,
    tenant as unknown as TenantPrismaService,
    {} as SatCatalogService,
  );
  const responseOwner = service as unknown as {
    enrichVariantCostResponse: (
      row: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  const enrich = responseOwner.enrichVariantCostResponse;
  const enrichment = jest
    .spyOn(responseOwner, 'enrichVariantCostResponse')
    .mockImplementation((row) => {
      events.push('enrich');
      expect(active).toBe(true);
      expect(tenant.getClient()).toBe(tx);
      return enrich(row);
    });
  return {
    enrichment,
    service,
    tx,
    repo,
    tenant,
    root,
    product,
    events,
    initial,
    effects: () => persisted,
  };
}

describe('addVariant lifecycle-first membership coordination', () => {
  it('locks before the fresh read/insert and commits existing defaults, prices and flags', async () => {
    const f = fixture();
    const result = await f.service.addVariant(productId, {
      option: ' Color ',
      value: ' Red ',
      sku: ' red ',
      barcode: ' 123 ',
    });
    expect(f.events).toEqual([
      'lifecycle',
      'gate',
      'read',
      'insert',
      'lists',
      'prices',
      'flags',
      'enrich',
      'commit',
    ]);
    const [query] = f.tx.$queryRaw.mock.calls[0] as unknown as [
      { strings: string[]; values: unknown[] },
    ];
    expect(query.strings.join('?')).toMatch(
      /SELECT "id" FROM "products" WHERE "tenantId" = \?\s+AND "id" = \? FOR UPDATE/,
    );
    expect(query.values).toEqual([tenantId, productId]);
    expect(f.tenant.runInTransaction).toHaveBeenCalledTimes(1);
    expect(f.root.$transaction).not.toHaveBeenCalled();
    expect(f.repo.isSkuTaken).toHaveBeenCalledWith(' red ');
    expect(f.repo.isBarcodeTaken).toHaveBeenCalledWith(' 123 ');
    expect(result).toEqual({
      id: 'variant-1',
      productId,
      tenantId,
      name: 'Red',
      option: 'Color',
      value: 'Red',
      sku: 'RED',
      barcode: '123',
      quantity: 0,
      minQuantity: 0,
      purchaseNetCostCents: null,
      purchaseNetCostDecimal: null,
      catalogPublishMode: 'INHERIT',
      onlineStockPresentation: null,
      onlineStockPresentationCustomQty: null,
    });
    expect(f.effects()).toEqual({
      variants: [expect.objectContaining({ id: 'variant-1' })],
      prices: ['price-1', 'price-2'].map((priceListId) => ({
        variantId: 'variant-1',
        priceListId,
        priceCents: 0,
        tenantId,
      })),
      flags: {
        hasVariants: true,
        useLotsAndExpirations: false,
        quantity: 0,
        minQuantity: 0,
      },
    });
  });

  it.each(['gate', 'missing gate row', 'missing product', 'SKU', 'Barcode'])(
    'leaves observable persistence unchanged on %s rejection',
    async (failure) => {
      const f = fixture();
      if (failure === 'gate')
        f.tx.$queryRaw.mockRejectedValueOnce(new Error('gate failed'));
      if (failure === 'missing gate row')
        f.tx.$queryRaw.mockResolvedValueOnce([]);
      if (failure === 'missing product')
        f.repo.findById.mockResolvedValueOnce(null);
      if (failure === 'SKU') f.repo.isSkuTaken.mockResolvedValueOnce(true);
      if (failure === 'Barcode')
        f.repo.isBarcodeTaken.mockResolvedValueOnce(true);
      const message =
        failure === 'gate'
          ? 'gate failed'
          : failure === 'SKU'
            ? 'SKU'
            : failure === 'Barcode'
              ? 'Barcode'
              : 'Product';
      await expect(
        f.service.addVariant(productId, {
          name: 'Red',
          sku: 'RED',
          barcode: '123',
        }),
      ).rejects.toThrow(message);
      expect(f.effects()).toEqual(f.initial);
      expect(f.tx.variant.create).not.toHaveBeenCalled();
      expect(f.tx.variantPrice.createMany).not.toHaveBeenCalled();
      expect(f.tx.product.update).not.toHaveBeenCalled();
      if (failure === 'gate' || failure === 'missing gate row') {
        expect(f.repo.findById).not.toHaveBeenCalled();
      }
    },
  );

  it('discards staged variant and price effects when the final Product write fails', async () => {
    const f = fixture();
    f.tx.product.update.mockRejectedValueOnce(new Error('flag write failed'));
    await expect(
      f.service.addVariant(productId, { name: 'Red' }),
    ).rejects.toThrow('flag write failed');
    expect(f.tx.variant.create).toHaveBeenCalledTimes(1);
    expect(f.tx.variantPrice.createMany).toHaveBeenCalledTimes(1);
    expect(f.effects()).toEqual(f.initial);
  });

  it('uses locked stock/flag facts without treating hasVariants as membership evidence', async () => {
    const f = fixture();
    f.repo.findById.mockResolvedValueOnce(
      Product.create({
        id: productId,
        name: 'Fresh',
        useStock: false,
        hasVariants: true,
      }),
    );
    f.tx.priceList.findMany.mockResolvedValueOnce([]);
    const result = await f.service.addVariant(productId, {
      name: ' Explicit ',
      quantity: 7,
      minQuantity: 9,
      purchaseNetCostCents: 4500,
    });
    expect(result).toMatchObject({
      name: 'Explicit',
      quantity: 7,
      minQuantity: 0,
      purchaseNetCostCents: 4500,
      purchaseNetCostDecimal: 45,
    });
    expect(f.effects().variants).toHaveLength(1);
    expect(f.tx.product.update).not.toHaveBeenCalled();
    expect(f.tx.variantPrice.createMany).not.toHaveBeenCalled();
  });
});

describe('addVariant lifecycle and response ownership', () => {
  it('awaits exact SHARE before any Product observation and uses fresh lists', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.tx.$executeRaw.mockImplementationOnce(async () => {
      entered();
      await gate;
      return 0;
    });
    const operation = f.service.addVariant(productId, { name: 'Fresh' });
    // Also settles on an uncoordinated implementation, making RED deterministic.
    await Promise.race([waiting, operation.catch(() => undefined)]);
    try {
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [sql, ...values] = f.tx.$executeRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(sql.join('')).toBe(
        'LOCK TABLE "global_price_lists" IN SHARE MODE',
      );
      expect(values).toEqual([]);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
      expect(f.repo.findById).not.toHaveBeenCalled();
      expect(f.repo.isSkuTaken).not.toHaveBeenCalled();
      expect(f.repo.isBarcodeTaken).not.toHaveBeenCalled();
      expect(f.tx.variant.create).not.toHaveBeenCalled();
      expect(f.tx.priceList.findMany).not.toHaveBeenCalled();
      expect(f.tx.variantPrice.createMany).not.toHaveBeenCalled();
      expect(f.tx.product.update).not.toHaveBeenCalled();
      expect(f.enrichment).not.toHaveBeenCalled();
      f.tx.priceList.findMany.mockResolvedValueOnce([{ id: 'fresh-price' }]);
      f.repo.findById.mockResolvedValueOnce(
        Product.create({
          id: productId,
          name: 'Fresh parent',
          useStock: false,
          hasVariants: true,
        }),
      );
    } finally {
      release();
      await operation.catch(() => undefined);
    }
    expect(f.effects().prices).toEqual([
      {
        variantId: 'variant-1',
        priceListId: 'fresh-price',
        priceCents: 0,
        tenantId,
      },
    ]);
    expect(f.effects().flags).toEqual({});
    expect(f.root.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    'lifecycle',
    'gate',
    'read',
    'SKU',
    'barcode',
    'insert',
    'lists',
    'prices',
    'flags',
    'enrich',
  ] as const)(
    'preserves the original %s error and rolls back all effects',
    async (stage) => {
      const f = fixture();
      const error = new Error(`failure at ${stage}`);
      const stages = [
        f.tx.$executeRaw,
        f.tx.$queryRaw,
        f.repo.findById,
        f.repo.isSkuTaken,
        f.repo.isBarcodeTaken,
        f.tx.variant.create,
        f.tx.priceList.findMany,
        f.tx.variantPrice.createMany,
        f.tx.product.update,
        f.enrichment,
      ];
      const names = [
        'lifecycle',
        'gate',
        'read',
        'SKU',
        'barcode',
        'insert',
        'lists',
        'prices',
        'flags',
        'enrich',
      ];
      const index = names.indexOf(stage);
      stages[index].mockImplementationOnce(() => {
        throw error;
      });
      await expect(
        f.service.addVariant(productId, {
          name: 'Red',
          sku: 'red',
          barcode: '123',
        }),
      ).rejects.toBe(error);
      expect(f.effects()).toEqual(f.initial);
      for (const later of stages.slice(index + 1))
        expect(later).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toBe('rollback');
      expect(f.root.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps repeated ambient creations owned by the outer transaction (abort=%s)',
    async (abort) => {
      const f = fixture();
      const error = new Error('outer abort');
      const outer = f.tenant.runInTransaction(async () => {
        const first = await f.service.addVariant(productId, { name: 'First' });
        const second = await f.service.addVariant(productId, {
          name: 'Second',
        });
        expect(first.id).toBe('variant-1');
        expect(second.id).toBe('variant-2');
        expect(first).toEqual({
          ...f.enrichment.mock.calls[0][0],
          purchaseNetCostDecimal: null,
        });
        expect(second).toEqual({
          ...f.enrichment.mock.calls[1][0],
          purchaseNetCostDecimal: null,
        });
        expect(f.effects()).toEqual(f.initial);
        expect(f.events).not.toContain('commit');
        if (abort) throw error;
        return [first, second];
      });
      if (abort) {
        await expect(outer).rejects.toBe(error);
        expect(f.effects()).toEqual(f.initial);
      } else {
        await expect(outer).resolves.toHaveLength(2);
        expect(f.effects().variants.map((row) => row.id)).toEqual([
          'variant-1',
          'variant-2',
        ]);
        expect(f.effects().prices).toEqual(
          ['variant-1', 'variant-2'].flatMap((variantId) =>
            ['price-1', 'price-2'].map((priceListId) => ({
              variantId,
              priceListId,
              priceCents: 0,
              tenantId,
            })),
          ),
        );
        expect(f.events.filter((event) => event === 'commit')).toHaveLength(1);
      }
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(2);
      expect(f.root.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 0, 1234])(
    'preserves complete responses and zero-price fanout for cost %s',
    async (cost) => {
      for (const count of [0, 1, 3]) {
        const f = fixture();
        const lists = Array.from({ length: count }, (_, i) => ({
          id: `list-${i}`,
        }));
        f.tx.priceList.findMany.mockResolvedValueOnce(lists);
        const result = await f.service.addVariant(productId, {
          name: 'Named',
          quantity: 4,
          minQuantity: 2,
          purchaseNetCostCents: cost,
        });
        expect(result).toEqual({
          id: 'variant-1',
          productId,
          tenantId,
          name: 'Named',
          option: null,
          value: null,
          sku: null,
          barcode: null,
          quantity: 4,
          minQuantity: 2,
          purchaseNetCostCents: cost ?? null,
          purchaseNetCostDecimal: cost == null ? null : cost / 100,
          catalogPublishMode: 'INHERIT',
          onlineStockPresentation: null,
          onlineStockPresentationCustomQty: null,
        });
        expect(f.effects().prices).toEqual(
          lists.map(({ id }) => ({
            variantId: 'variant-1',
            priceListId: id,
            priceCents: 0,
            tenantId,
          })),
        );
        expect(f.effects().variants).toEqual([f.enrichment.mock.calls[0][0]]);
        expect(f.events.at(-1)).toBe('commit');
      }
    },
  );
});
