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
    $queryRaw: jest.fn(async () => {
      events.push('gate');
      locked = true;
      return [{ id: productId }];
    }),
    variant: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push('insert');
        const row = { id: 'variant-1', ...data };
        pending.variants.push(row);
        return row;
      }),
    },
    priceList: {
      findMany: jest.fn(async () => [{ id: 'price-1' }, { id: 'price-2' }]),
    },
    variantPrice: {
      createMany: jest.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          pending.prices.push(...data);
          return { count: data.length };
        },
      ),
    },
    product: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        pending.flags = data;
        return data;
      }),
    },
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: jest.fn(() => (active ? tx : root)),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      active = true;
      pending = structuredClone(persisted);
      try {
        const result = await work();
        persisted = structuredClone(pending);
        return result;
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
    findById: jest.fn(async () => {
      events.push('read');
      expect(active).toBe(true);
      expect(locked).toBe(true);
      expect(tenant.getClient()).toBe(tx);
      return product as Product | null;
    }),
    isSkuTaken: jest.fn(async () => {
      expect(tenant.getClient()).toBe(tx);
      return false;
    }),
    isBarcodeTaken: jest.fn(async () => {
      expect(tenant.getClient()).toBe(tx);
      return false;
    }),
  };
  const service = new ProductsService(
    repo as unknown as IProductRepository,
    root as unknown as PrismaService,
    {} as FilesService,
    tenant as unknown as TenantPrismaService,
    {} as SatCatalogService,
  );
  return {
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

describe('addVariant Product-first membership coordination', () => {
  it('locks before the fresh read/insert and commits existing defaults, prices and flags', async () => {
    const f = fixture();
    const result = await f.service.addVariant(productId, {
      option: ' Color ',
      value: ' Red ',
      sku: ' red ',
      barcode: ' 123 ',
    });
    expect(f.events).toEqual(['gate', 'read', 'insert']);
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
    expect(result).toMatchObject({
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
