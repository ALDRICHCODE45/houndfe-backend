import type { Prisma } from '@prisma/client';
import { readEditorialOfferedSubjectsV2 as read } from './prisma-editorial-offered-subjects-v2';

const scope = { tenantId: 'tenant', productId: 'product' };
function row() {
  return {
    type: 'PRODUCT' as 'PRODUCT' | 'SERVICE',
    includeInOnlineCatalog: true,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    hasVariants: true,
    tenant: {
      isActive: false,
      catalogPublished: false,
      tenantCatalogPriceLists: [
        { globalPriceListId: 'b' },
        { globalPriceListId: 'a' },
      ],
    },
    catalogPriceLists: [] as { globalPriceListId: string }[],
    priceLists: [
      { id: 'pa', globalPriceListId: 'a', priceCents: 0 },
      { id: 'pb', globalPriceListId: 'b', priceCents: 100 },
    ],
    variants: [
      {
        id: 'v1',
        catalogPublishMode: 'INHERIT',
        variantPrices: [{ priceListId: 'pb', priceCents: 25 }],
      },
      {
        id: 'v2',
        catalogPublishMode: 'ON',
        variantPrices: [{ priceListId: 'pa', priceCents: 50 }],
      },
      {
        id: 'off',
        catalogPublishMode: 'OFF',
        variantPrices: [{ priceListId: 'pb', priceCents: 25 }],
      },
    ],
  };
}
function fixture(value: ReturnType<typeof row> | null = row()) {
  const findFirst = jest
    .fn<Promise<ReturnType<typeof row> | null>, [Prisma.ProductFindFirstArgs]>()
    .mockResolvedValue(value);
  const calls: string[] = [];
  const tx = new Proxy(
    { product: { findFirst } },
    {
      get(target, key) {
        calls.push(String(key));
        if (key !== 'product')
          throw new Error(`Unexpected client operation ${String(key)}`);
        return target.product;
      },
    },
  ) as unknown as Prisma.TransactionClient;
  return { tx, findFirst, calls };
}

it('loads the complete qualified observation without visibility/default/price truncation', async () => {
  const f = fixture();
  await expect(read(f.tx, scope)).resolves.toEqual(['v1']);
  expect(f.findFirst.mock.calls).toEqual([
    [
      {
        where: { id: 'product', tenantId: 'tenant' },
        select: {
          type: true,
          includeInOnlineCatalog: true,
          hidePriceInOnlineCatalog: true,
          requiresPrescription: true,
          hasVariants: true,
          tenant: {
            select: {
              tenantCatalogPriceLists: {
                where: { tenantId: 'tenant' },
                select: { globalPriceListId: true },
              },
            },
          },
          catalogPriceLists: {
            where: { tenantId: 'tenant', productId: 'product' },
            select: { globalPriceListId: true },
          },
          priceLists: {
            where: { tenantId: 'tenant', productId: 'product' },
            select: { id: true, globalPriceListId: true, priceCents: true },
          },
          variants: {
            where: { tenantId: 'tenant', productId: 'product' },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              catalogPublishMode: true,
              variantPrices: {
                where: {
                  tenantId: 'tenant',
                  priceList: { tenantId: 'tenant', productId: 'product' },
                },
                select: { priceListId: true, priceCents: true },
              },
            },
          },
        },
      },
    ],
  ]);
  expect(f.calls).toEqual(['product']);
});

it.each([false, true])(
  'uses all configured contexts independently of effective visibility=%s',
  async (visible) => {
    const value = row();
    value.tenant.isActive = visible;
    value.tenant.catalogPublished = visible;
    value.priceLists[0].priceCents = 10;
    const f = fixture(value);
    await expect(read(f.tx, scope)).resolves.toEqual(['v1', 'v2']);
    value.tenant.tenantCatalogPriceLists = [];
    await expect(read(f.tx, scope)).resolves.toEqual([]);
  },
);

it('preserves stale allowlists and uses actual product-price row identities', async () => {
  const value = row();
  value.catalogPriceLists = [{ globalPriceListId: 'stale' }];
  const f = fixture(value);
  await expect(read(f.tx, scope)).resolves.toEqual([]);
  value.catalogPriceLists = [{ globalPriceListId: 'b' }];
  await expect(read(f.tx, scope)).resolves.toEqual(['v1']);
  value.variants[0].variantPrices[0].priceListId = 'b';
  await expect(read(f.tx, scope)).resolves.toEqual([]);
});

it.each(['hidePriceInOnlineCatalog', 'requiresPrescription'] as const)(
  'composes %s precedence with real membership',
  async (flag) => {
    const value = row();
    value[flag] = true;
    value.priceLists = [];
    value.catalogPriceLists = [{ globalPriceListId: 'stale' }];
    const f = fixture(value);
    await expect(read(f.tx, scope)).resolves.toEqual(['v1', 'v2']);
    value.hasVariants = false;
    await expect(read(f.tx, scope)).resolves.toEqual([null]);
    value.includeInOnlineCatalog = false;
    await expect(read(f.tx, scope)).resolves.toEqual([]);
  },
);

it('composes simple products and SERVICE exclusion without inventing subjects', async () => {
  const value = row();
  value.hasVariants = false;
  const f = fixture(value);
  await expect(read(f.tx, scope)).resolves.toEqual([null]);
  value.type = 'SERVICE';
  await expect(read(f.tx, scope)).resolves.toEqual([]);
});

it('distinguishes missing Product from empty E and preserves source error identity', async () => {
  const f = fixture(null);
  await expect(read(f.tx, scope)).rejects.toThrow('NOT_FOUND');
  const error = new Error('query failed');
  f.findFirst.mockRejectedValueOnce(error);
  await expect(read(f.tx, scope)).rejects.toBe(error);
  expect(f.findFirst).toHaveBeenCalledTimes(2);
  expect(f.calls).toEqual(['product', 'product']);
});

it.each(['tenantId', 'productId'] as const)(
  'rejects invalid internal %s before client access',
  async (key) => {
    const f = fixture();
    await expect(read(f.tx, { ...scope, [key]: ' ' })).rejects.toThrow(
      TypeError,
    );
    expect(f.calls).toEqual([]);
  },
);

it('captures scope before awaiting and leaves caller data unchanged', async () => {
  const value = row();
  const before = JSON.stringify(value);
  const f = fixture(value);
  let release!: (value: ReturnType<typeof row>) => void;
  f.findFirst.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const mutableScope = { ...scope };
  const pending = read(f.tx, mutableScope);
  mutableScope.tenantId = 'other';
  mutableScope.productId = 'other-product';
  expect(f.findFirst.mock.calls[0][0].where).toEqual({
    tenantId: 'tenant',
    id: 'product',
  });
  release(value);
  await expect(pending).resolves.toEqual(['v1']);
  expect(JSON.stringify(value)).toBe(before);
  expect(f.calls).toEqual(['product']);
});
