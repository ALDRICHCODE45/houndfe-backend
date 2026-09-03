/*
 * F1.WU4a — catalog persistence foundation: scalar persistence, atomic
 * allowlist replacement, zero-IDs-zero-rows, read reconstruction; plus
 * structural (not physical-rollback) proofs of one transaction boundary
 * per save(), ambient reuse, tx-client delegates, failure propagation.
 */
import { PrismaProductRepository } from './prisma-product.repository';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { IStockAlertStateRepository } from '../../stock-alerts/domain/stock-alert-state.repository';
import { Product } from '../domain/product.entity';

const TENANT = 'tenant-1';

type Args = Record<string, unknown>;

const EXPECTED_INCLUDE = {
  serviceDetail: true,
  catalogPriceLists: { select: { globalPriceListId: true } },
};

function makeHarness(
  rowOverrides: Args = {},
  opts: { ambient?: boolean; failCreateMany?: Error } = {},
) {
  const row = {
    // Scalar fields `Product.fromPersistence` consumes, from the entity.
    ...Product.create({ id: 'prod-1', name: 'Test Product' }).toPersistence(),
    serviceDetail: null,
    catalogPriceLists: [] as Array<{ globalPriceListId: string }>,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...rowOverrides,
  };
  // Delegates record a timeline entry and the client (`this`) they ran on.
  const timeline: string[] = [];
  const captured: Record<string, Args> = {};
  const clients: unknown[] = [];
  const delegate = (name: string, result: () => Promise<unknown>) =>
    jest.fn(function (this: unknown, args: Args) {
      timeline.push(name);
      clients.push(this);
      captured[name] = args;
      return result();
    });
  const prisma = {
    product: {
      upsert: delegate('upsert', () => Promise.resolve(row)),
      findUnique: delegate('findUnique', () => Promise.resolve(row)),
    },
    productCatalogPriceList: {
      deleteMany: delegate('deleteMany', () => Promise.resolve({ count: 0 })),
      createMany: delegate('createMany', () =>
        opts.failCreateMany
          ? Promise.reject(opts.failCreateMany)
          : Promise.resolve({ count: 0 }),
      ),
    },
  };
  // Mimics TenantPrismaService.runInTransaction: reuse an ambient
  // transaction; otherwise open exactly one.
  const state = { ambient: opts.ambient ?? false, entered: 0, opened: 0 };
  const tenantPrisma = {
    getClient: jest.fn(() => prisma),
    getTenantId: jest.fn(() => TENANT),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      state.entered += 1;
      if (!state.ambient) state.opened += 1;
      const previous = state.ambient;
      state.ambient = true;
      timeline.push('tx:enter');
      try {
        return await work();
      } finally {
        timeline.push('tx:exit');
        state.ambient = previous;
      }
    }),
  };
  const repo = new PrismaProductRepository(
    tenantPrisma as never,
    { publish: jest.fn() } as unknown as OutboxWriterService,
    {
      seedAndFlip: jest.fn(),
      rearm: jest.fn(),
    } as unknown as IStockAlertStateRepository,
  );
  return { repo, prisma, captured, clients, timeline, state };
}

describe('PrismaProductRepository catalog fields (F1.WU4a)', () => {
  it('persists catalog scalars and atomically replaces a non-empty allowlist', async () => {
    const h = makeHarness({
      hidePriceInOnlineCatalog: true,
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 5,
      catalogPriceLists: [
        { globalPriceListId: 'pl-1' },
        { globalPriceListId: 'pl-2' },
      ],
    });
    const saved = await h.repo.save(
      Product.create({
        id: 'prod-1',
        name: 'Test Product',
        hidePriceInOnlineCatalog: true,
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 5,
        supportedCatalogPriceListIds: ['pl-1', 'pl-2'],
      }),
    );

    expect(h.captured.upsert?.update).toMatchObject({
      hidePriceInOnlineCatalog: true,
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 5,
    });
    expect(h.captured.upsert?.create).toMatchObject({
      hidePriceInOnlineCatalog: true,
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 5,
      tenantId: TENANT,
    });
    // Explicit tenant + product scoping on the replacement delete.
    expect(h.captured.deleteMany?.where).toEqual({
      tenantId: TENANT,
      productId: 'prod-1',
    });
    expect(h.captured.createMany?.data).toEqual([
      { tenantId: TENANT, productId: 'prod-1', globalPriceListId: 'pl-1' },
      { tenantId: TENANT, productId: 'prod-1', globalPriceListId: 'pl-2' },
    ]);
    // Reload after replacement; the aggregate reflects the persisted rows.
    expect(h.captured.findUnique?.include).toEqual(EXPECTED_INCLUDE);
    expect(saved.supportedCatalogPriceListIds).toEqual(['pl-1', 'pl-2']);
    expect(saved.hidePriceInOnlineCatalog).toBe(true);
    expect(saved.onlineStockPresentation).toBe('CUSTOM_QUANTITY');
    expect(saved.onlineStockPresentationCustomQty).toBe(5);
    expect(saved.toResponse().supportsAllCatalogPriceLists).toBe(false);
  });

  it('zero IDs means zero rows: delete runs, createMany is skipped', async () => {
    const h = makeHarness();
    const saved = await h.repo.save(
      Product.create({ id: 'prod-1', name: 'Test Product' }),
    );

    expect(h.captured.deleteMany?.where).toEqual({
      tenantId: TENANT,
      productId: 'prod-1',
    });
    expect(h.captured.createMany).toBeUndefined();
    expect(saved.supportedCatalogPriceListIds).toEqual([]);
    expect(saved.toResponse().supportsAllCatalogPriceLists).toBe(true);
  });

  it('reconstructs the allowlist relation on read without losing IDs', async () => {
    const h = makeHarness({
      catalogPriceLists: [
        { globalPriceListId: 'pl-a' },
        { globalPriceListId: 'pl-b' },
      ],
    });
    const found = await h.repo.findById('prod-1');

    expect(h.captured.findUnique?.include).toEqual(EXPECTED_INCLUDE);
    expect(found?.supportedCatalogPriceListIds).toEqual(['pl-a', 'pl-b']);
    expect(found?.toResponse().supportsAllCatalogPriceLists).toBe(false);
  });

  it('preserves loaded stale IDs through an unrelated save in replacement order', async () => {
    const h = makeHarness({
      catalogPriceLists: [
        { globalPriceListId: 'stale-a' },
        { globalPriceListId: 'stale-b' },
      ],
    });
    const product = await h.repo.findById('prod-1');
    product?.updateName('Renamed only');
    await h.repo.save(product!);

    expect(h.captured.createMany?.data).toEqual(
      expect.arrayContaining([
        { tenantId: TENANT, productId: 'prod-1', globalPriceListId: 'stale-a' },
        { tenantId: TENANT, productId: 'prod-1', globalPriceListId: 'stale-b' },
      ]),
    );
    expect(h.captured.createMany?.data).toHaveLength(2);
    expect(h.timeline).toEqual([
      'findUnique',
      'tx:enter',
      'upsert',
      'deleteMany',
      'createMany',
      'findUnique',
      'tx:exit',
    ]);
  });

  it('enters the boundary once and reuses an ambient transaction', async () => {
    // First save: exactly one boundary opens; all delegates run inside it,
    // in order, on the boundary's transaction/tenant client (structural
    // identity proof — the mock shares one client object).
    const h = makeHarness();
    await h.repo.save(Product.create({ id: 'prod-1', name: 'Test Product' }));
    expect(h.state).toEqual({ ambient: false, entered: 1, opened: 1 });
    expect(h.timeline).toEqual([
      'tx:enter',
      'upsert',
      'deleteMany',
      'findUnique',
      'tx:exit',
    ]);
    expect(h.clients).toEqual([
      h.prisma.product,
      h.prisma.productCatalogPriceList,
      h.prisma.product,
    ]);

    // Second save while a service-owned transaction is ambient: it must
    // join that boundary instead of opening a nested second transaction.
    h.state.ambient = true; // service-owned tx now ambient
    await h.repo.save(Product.create({ id: 'prod-1', name: 'Test Product' }));
    expect(h.state.entered).toBe(2);
    expect(h.state.opened).toBe(1);
  });

  it('propagates a join creation failure from inside the boundary', async () => {
    const boom = new Error('join insert failed');
    const h = makeHarness({}, { failCreateMany: boom });

    // The rejection must escape the runInTransaction work so the real
    // transaction aborts (rollback); the mock proves propagation only.
    await expect(
      h.repo.save(
        Product.create({
          id: 'prod-1',
          name: 'Test Product',
          supportedCatalogPriceListIds: ['pl-1'],
        }),
      ),
    ).rejects.toBe(boom);
    expect(h.timeline).toEqual([
      'tx:enter',
      'upsert',
      'deleteMany',
      'createMany',
      'tx:exit',
    ]);
  });
});
