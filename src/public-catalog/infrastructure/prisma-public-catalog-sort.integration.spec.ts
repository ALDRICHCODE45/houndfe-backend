/**
 * INTEGRATION SPEC: public catalog `sort` (public catalog v0, S1).
 *
 * Real PostgreSQL (test DB, never dev). price_asc / price_desc order ALL
 * eligible products by the card's «desde» price in the selected price
 * context — the minimum positive price of the non-OFF variants when the
 * product has variants, else the product price — with hidden-price products
 * last, then name, then id. The page is cut from that global order.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { disconnectIntegrationPrisma } from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  ListPublicProductsUseCase,
  type ListProductsInput,
} from '../application/use-cases/list-public-products.use-case';
import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('public catalog sort (PostgreSQL)', () => {
  const tenantId = randomUUID();
  const slug = `pc-srt-${tenantId.slice(0, 8)}`;
  const tenant = { id: tenantId, slug, name: `PC SRT ${slug}` };
  const listA = randomUUID();
  const listB = randomUUID();
  const categoryId = randomUUID();
  let prisma: PrismaClient;
  let repo: PrismaPublicCatalogRepository;
  let list: ListPublicProductsUseCase;
  const created = new Map<string, string>(); // product name -> id

  const id = (name: string): string => {
    const found = created.get(name);
    if (!found) throw new Error(`unknown fixture ${name}`);
    return found;
  };

  async function seed(
    name: string,
    opts: {
      prices: { a?: number; b?: number };
      variants?: { a?: number; b?: number; mode?: 'INHERIT' | 'OFF' }[];
      hidePrice?: boolean;
      requiresPrescription?: boolean;
      createdAt?: Date;
    },
  ): Promise<void> {
    const productId = randomUUID();
    created.set(name, productId);
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name,
        sku: `pc-srt-${productId.slice(0, 8)}`,
        categoryId,
        quantity: 50,
        hasVariants: Boolean(opts.variants),
        hidePriceInOnlineCatalog: opts.hidePrice ?? false,
        requiresPrescription: opts.requiresPrescription ?? false,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    const rows: Record<'a' | 'b', string | undefined> = {
      a: undefined,
      b: undefined,
    };
    for (const [key, listId] of [
      ['a', listA],
      ['b', listB],
    ] as const) {
      const priceCents = opts.prices[key];
      if (priceCents === undefined) continue;
      const row = await prisma.priceList.create({
        data: { tenantId, productId, globalPriceListId: listId, priceCents },
      });
      rows[key] = row.id;
    }
    for (const [i, v] of (opts.variants ?? []).entries()) {
      const variantId = randomUUID();
      await prisma.variant.create({
        data: {
          id: variantId,
          tenantId,
          productId,
          name: `${name} v${i}`,
          option: 'Talla',
          value: `v${i}`,
          quantity: 50,
          catalogPublishMode: v.mode ?? 'INHERIT',
        },
      });
      for (const key of ['a', 'b'] as const) {
        const priceCents = v[key];
        const priceListId = rows[key];
        if (priceCents === undefined || priceListId === undefined) continue;
        await prisma.variantPrice.create({
          data: { tenantId, variantId, priceListId, priceCents },
        });
      }
    }
  }

  async function page(
    sort: ListProductsInput['sort'],
    opts: {
      page?: number;
      limit?: number;
      priceListId?: string;
      q?: string;
    } = {},
  ) {
    const context = await repo.resolveTenantCatalogContext(
      slug,
      opts.priceListId,
    );
    if (!context) throw new Error('context');
    return list.executeForContext({
      tenant,
      context,
      filters: {
        sort,
        q: opts.q,
        categoryId,
        page: opts.page ?? 1,
        limit: opts.limit ?? 50,
      },
    });
  }

  const names = (result: { items: { id: string }[] }): string[] => {
    const byId = new Map([...created].map(([name, pid]) => [pid, name]));
    return result.items.map((item) => byId.get(item.id) ?? item.id);
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    repo = new PrismaPublicCatalogRepository(
      prisma as unknown as ConstructorParameters<
        typeof PrismaPublicCatalogRepository
      >[0],
      tenantPrisma,
    );
    list = new ListPublicProductsUseCase(repo);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: tenant.name,
        slug,
        isActive: true,
        catalogPublished: true,
      },
    });
    await prisma.category.create({
      data: { id: categoryId, name: `pc-srt-cat-${categoryId.slice(0, 8)}` },
    });
    for (const [listId, isCatalogDefault] of [
      [listA, true],
      [listB, false],
    ] as const) {
      await prisma.globalPriceList.create({
        data: { id: listId, name: `pc-srt-${listId}` },
      });
      await prisma.tenantCatalogPriceList.create({
        data: { tenantId, globalPriceListId: listId, isCatalogDefault },
      });
    }

    // Created oldest -> newest so `newest` has a known order (Hidden last).
    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    // «desde» in list A: Gamma 1500, Aaa 3000, Beta 3000, Zeta 5000,
    // Eta 6000 (OFF variant at 100 ignored), Delta 8000.
    await seed('Zeta', { prices: { a: 5000, b: 100 }, createdAt: t(1) });
    await seed('Beta', { prices: { a: 3000, b: 9500 }, createdAt: t(2) });
    await seed('Aaa', { prices: { a: 3000, b: 9400 }, createdAt: t(3) });
    // Product price 9000 is NOT the «desde»: the cheapest variant is.
    await seed('Gamma', {
      prices: { a: 9000, b: 9000 },
      variants: [
        { a: 1500, b: 8800 },
        { a: 7000, b: 8900 },
      ],
      createdAt: t(4),
    });
    // Product price 1000 is NOT the «desde» either.
    await seed('Delta', {
      prices: { a: 1000, b: 1000 },
      variants: [
        { a: 8000, b: 50 },
        { a: 9000, b: 60 },
      ],
      createdAt: t(5),
    });
    await seed('Eta', {
      prices: { a: 7777, b: 7777 },
      variants: [
        { a: 100, b: 100, mode: 'OFF' },
        { a: 6000, b: 6000 },
      ],
      createdAt: t(6),
    });
    // Hidden price / prescription: last in both directions, whatever the
    // numbers say (the cheapest and the dearest).
    await seed('HiddenCheap', {
      prices: { a: 1, b: 1 },
      hidePrice: true,
      createdAt: t(7),
    });
    await seed('RxDear', {
      prices: { a: 99999, b: 99999 },
      requiresPrescription: true,
      createdAt: t(8),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await prisma.variantPrice.deleteMany({ where: { tenantId } });
      await prisma.variant.deleteMany({ where: { tenantId } });
      await prisma.priceList.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.tenantCatalogPriceList.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: [listA, listB] } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
    } finally {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    }
  });

  it('price_asc orders every eligible product by «desde», hidden last, then name', async () => {
    expect(names(await page('price_asc'))).toEqual([
      'Gamma', // variant 1500 (product price 9000 ignored)
      'Aaa', // 3000, name before Beta
      'Beta', // 3000
      'Zeta', // 5000
      'Eta', // 6000 (OFF variant at 100 ignored)
      'Delta', // variant 8000 (product price 1000 ignored)
      'HiddenCheap', // hidden last, name then
      'RxDear',
    ]);
  });

  it('price_desc reverses the price order but keeps hidden last and name ascending on ties', async () => {
    expect(names(await page('price_desc'))).toEqual([
      'Delta',
      'Eta',
      'Zeta',
      'Aaa',
      'Beta',
      'Gamma',
      'HiddenCheap',
      'RxDear',
    ]);
  });

  it.each(['price_asc', 'price_desc'] as const)(
    '%s is a global order: the pages concatenate to it and total is unchanged',
    async (sort) => {
      const full = names(await page(sort));
      const pages: Awaited<ReturnType<typeof page>>[] = [];
      for (let p = 1; p <= 4; p++)
        pages.push(await page(sort, { page: p, limit: 2 }));
      expect(pages.flatMap(names)).toEqual(full);
      expect(pages[0].meta).toMatchObject({ total: 8, totalPages: 4 });
      // Page 1 holds the two extremes of the WHOLE catalog, not of a slice.
      expect(names(pages[0])).toEqual(full.slice(0, 2));
      expect(pages[1].items).toHaveLength(2);
      expect((await page(sort, { page: 5, limit: 2 })).items).toEqual([]);
    },
  );

  it('uses the selected price context, not the default list', async () => {
    // List B «desde»: Delta 50, Eta 100 (OFF variant ignored? it is OFF so
    // 6000... its B price is 6000), Zeta 100, Gamma 8800, Beta 9500, Aaa 9400.
    expect(names(await page('price_asc', { priceListId: listB }))).toEqual([
      'Delta', // variant 50
      'Zeta', // 100
      'Eta', // 6000
      'Gamma', // 8800
      'Aaa', // 9400
      'Beta', // 9500
      'HiddenCheap',
      'RxDear',
    ]);
  });

  it('applies q and category filters before ordering and paging', async () => {
    const result = await page('price_desc', { q: 'a', limit: 3 });
    // q "a" matches Zeta, Beta, Aaa, Gamma, Delta, Eta, HiddenCheap and the
    // variant names of the rest; every match is ordered globally.
    const full = names(await page('price_desc', { q: 'a' }));
    expect(names(result)).toEqual(full.slice(0, 3));
    expect(result.meta.total).toBe(full.length);
  });

  describe('previous behavior holds', () => {
    it('newest (and relevance / rating_desc) keep ordering by createdAt desc', async () => {
      const newest = [
        'RxDear',
        'HiddenCheap',
        'Eta',
        'Delta',
        'Gamma',
        'Aaa',
        'Beta',
        'Zeta',
      ];
      expect(names(await page('newest'))).toEqual(newest);
      expect(names(await page('relevance'))).toEqual(newest);
      expect(names(await page('rating_desc'))).toEqual(newest);
    });

    it('the price sorts return the same items and totals as newest', async () => {
      const newest = await page('newest');
      for (const sort of ['price_asc', 'price_desc'] as const) {
        const sorted = await page(sort);
        expect([...names(sorted)].sort()).toEqual([...names(newest)].sort());
        expect(sorted.meta).toEqual(newest.meta);
        expect(sorted.excludedCount).toBe(newest.excludedCount);
        expect(sorted.facets).toEqual(newest.facets);
      }
    });

    it('the card still shows the same price fields while sorted', async () => {
      const [first] = (await page('price_asc')).items;
      expect(first.id).toBe(id('Gamma'));
      expect(first.price).toEqual({
        fromPriceCents: 1500,
        priceCents: 9000,
        hidden: false,
      });
    });
  });
});
