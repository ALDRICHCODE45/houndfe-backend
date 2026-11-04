import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ProductsService } from '../products/products.service';
import type { PriceListsService } from './price-lists.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { lockCatalogLifecycle } from '../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import { loadEditorialPostgresClient } from '../catalog-editorial/infrastructure/editorial-coordination-postgres-binding';
import {
  currentBackendPid,
  seedEditorialPostgres,
  waitForLockWait,
} from '../catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('live global price-list lifecycle deletion', () => {
  const opened: PrismaClient[] = [];
  const open = async () => {
    const client = await loadEditorialPostgresClient();
    opened.push(client);
    return client;
  };
  let observer: PrismaClient;
  let actor: (
    client: PrismaClient,
    tenantId?: string | null,
  ) => {
    run: <T>(
      work: (
        service: PriceListsService,
        products: ProductsService,
      ) => Promise<T>,
    ) => Promise<T>;
    transaction: <T>(work: () => Promise<T>) => Promise<T>;
  };
  beforeAll(async () => {
    observer = await open(); // Binding admission precedes application imports.
    const { PriceListsService } = await import('./price-lists.service');
    const { ProductsService } = await import('../products/products.service');
    const { PrismaProductRepository } =
      await import('../products/infrastructure/prisma-product.repository');
    const { TenantPrismaService } =
      await import('../shared/prisma/tenant-prisma.service');
    const { ClsService } = await import('nestjs-cls');
    const cls = new ClsService<TenantClsStore>(
      new AsyncLocalStorage<TenantClsStore>(),
    );
    actor = (client, tenantId = null) => {
      const prisma = client as ConstructorParameters<
        typeof PriceListsService
      >[0];
      const tenant = new TenantPrismaService(prisma, cls);
      const service = new PriceListsService(prisma, tenant);
      const unused = new Proxy(
        {},
        {
          get() {
            throw new Error('Unexpected create collaborator');
          },
        },
      );
      type RepositoryArgs = ConstructorParameters<
        typeof PrismaProductRepository
      >;
      const repository = new PrismaProductRepository(
        tenant,
        unused as RepositoryArgs[1],
      );
      type ProductArgs = ConstructorParameters<typeof ProductsService>;
      const products = new ProductsService(
        repository,
        prisma,
        unused as ProductArgs[2],
        tenant,
        unused as ProductArgs[4],
        unused as ProductArgs[5],
      );
      return {
        run: (work) =>
          cls.runWith(
            {
              tenantId,
              userId: 'synthetic-lifecycle-actor',
              isSuperAdmin: tenantId === null,
            },
            () => work(service, products),
          ),
        transaction: (work) => tenant.runInTransaction(work),
      };
    };
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((c) => c.$disconnect()));
  });

  async function snapshot(id: string) {
    const where = { globalPriceListId: id };
    return {
      global: await observer.globalPriceList.findUnique({ where: { id } }),
      prices: await observer.priceList.findMany({
        where,
        orderBy: { id: 'asc' },
        include: {
          variantPrices: {
            orderBy: { id: 'asc' },
            include: { tierPrices: { orderBy: { id: 'asc' } } },
          },
        },
      }),
      tenants: await observer.tenantCatalogPriceList.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      products: await observer.productCatalogPriceList.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function witness(waiter: number, owner: number, mode: string) {
    expect(await waitForLockWait(observer, waiter)).toContain(owner);
    const locks = await observer.$queryRaw<{ mode: string }[]>`
      SELECT mode FROM pg_locks WHERE pid = ${waiter} AND NOT granted
        AND relation = 'global_price_lists'::regclass`;
    expect(locks).toEqual([{ mode }]);
  }
  async function assertMatrix(
    id: string,
    tenantId: string,
    productId: string,
    variantIds: string[],
  ) {
    const rows = await snapshot(id);
    expect(rows.prices).toHaveLength(1);
    expect(rows.prices[0]).toMatchObject({
      tenantId,
      productId,
      priceCents: 0,
    });
    expect(
      rows.prices[0].variantPrices
        .map((v) => ({
          variantId: v.variantId,
          tenantId: v.tenantId,
          priceCents: v.priceCents,
          tierPrices: v.tierPrices,
        }))
        .sort((a, b) => a.variantId.localeCompare(b.variantId)),
    ).toEqual(
      variantIds.sort().map((variantId) => ({
        variantId,
        tenantId,
        priceCents: 0,
        tierPrices: [],
      })),
    );
    expect(rows.tenants).toEqual([]);
    expect(rows.products).toEqual([]);
  }

  it('creates a fresh matrix after an actual variant creator releases SHARE', async () => {
    const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
    const prior = await snapshot(i.globalPriceListId);
    const firstClient = await open();
    const firstPid = await currentBackendPid(firstClient);
    const secondClient = await open();
    const secondPid = await currentBackendPid(secondClient);
    const first = actor(firstClient, i.tenantId);
    const second = actor(secondClient, i.tenantId);
    const reached = signal();
    const release = signal();
    let variantId = '';
    const holding = first
      .run((_s, products) =>
        first.transaction(async () => {
          const variant = await products.addVariant(i.productId, {
            name: 'Added before global',
          });
          variantId = variant.id;
          reached.resolve();
          await release.promise;
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let creating:
      | Promise<Awaited<ReturnType<PriceListsService['create']>>>
      | undefined;
    try {
      await Promise.race([
        reached.promise,
        holding.then((cause) => {
          throw new Error('Variant ended before checkpoint', { cause });
        }),
      ]);
      creating = second.run((service) =>
        service.create({ name: randomUUID() }),
      );
      await witness(secondPid, firstPid, 'ShareRowExclusiveLock');
      const locks = await observer.$queryRaw<{ relation: string }[]>`
        SELECT relation::regclass::text AS relation FROM pg_locks WHERE pid = ${secondPid}
          AND granted AND relation IN ('products'::regclass, 'price_lists'::regclass, 'variants'::regclass)`;
      expect(locks).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, creating]);
    }
    await expect(holding).resolves.toBeUndefined();
    const created = await creating;
    await expect(
      observer.globalPriceList.findUnique({ where: { id: created.id } }),
    ).resolves.toEqual(created);
    await assertMatrix(created.id, i.tenantId, i.productId, [
      i.variantId,
      variantId,
    ]);
    const after = await snapshot(i.globalPriceListId);
    expect(after.global).toEqual(prior.global);
    expect(
      after.prices[0].variantPrices.filter((v) => v.variantId !== variantId),
    ).toEqual(prior.prices[0].variantPrices);
  });

  it.each([false, true])(
    'keeps create exclusive through outer completion, rollback=%s',
    async (rollback) => {
      const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
      const before = await snapshot(i.globalPriceListId);
      const firstClient = await open();
      const firstPid = await currentBackendPid(firstClient);
      const secondClient = await open();
      const secondPid = await currentBackendPid(secondClient);
      const first = actor(firstClient, i.tenantId);
      const second = actor(secondClient, i.tenantId);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback complete global matrix');
      let created: Awaited<ReturnType<PriceListsService['create']>> | undefined;
      const holding = first
        .run((service) =>
          first.transaction(async () => {
            created = await service.create({ name: randomUUID() });
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let adding:
        | Promise<Awaited<ReturnType<ProductsService['addVariant']>>>
        | undefined;
      try {
        await Promise.race([
          reached.promise,
          holding.then((cause) => {
            throw new Error('Create ended before checkpoint', { cause });
          }),
        ]);
        adding = second.run((_s, products) =>
          products.addVariant(i.productId, { name: 'After global' }),
        );
        await witness(secondPid, firstPid, 'ShareLock');
        expect(await snapshot(created!.id)).toEqual({
          global: null,
          prices: [],
          tenants: [],
          products: [],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([holding, adding]);
      }
      await expect(holding).resolves.toBe(rollback ? abort : undefined);
      const added = await adding;
      if (rollback)
        expect(await snapshot(created!.id)).toEqual({
          global: null,
          prices: [],
          tenants: [],
          products: [],
        });
      else {
        await expect(
          observer.globalPriceList.findUnique({ where: { id: created!.id } }),
        ).resolves.toEqual(created);
        await assertMatrix(created!.id, i.tenantId, i.productId, [
          i.variantId,
          added.id,
        ]);
      }
      const after = await snapshot(i.globalPriceListId);
      expect(after.global).toEqual(before.global);
      expect(
        after.prices[0].variantPrices.filter((v) => v.variantId !== added.id),
      ).toEqual(before.prices[0].variantPrices);
      await expect(
        observer.variantPrice.count({ where: { variantId: added.id } }),
      ).resolves.toBe(rollback ? 1 : 2);
    },
  );

  it.each([false, true])(
    'serializes same-name creation across selected tenants, first rollback=%s',
    async (rollback) => {
      const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
      const prior = await snapshot(i.globalPriceListId);
      const name = randomUUID();
      const firstClient = await open();
      const firstPid = await currentBackendPid(firstClient);
      const secondClient = await open();
      const secondPid = await currentBackendPid(secondClient);
      const first = actor(firstClient, i.tenantId);
      const second = actor(secondClient, i.foreignTenantId);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback first same-name creator');
      let firstId = '';
      const holding = first
        .run((service) =>
          first.transaction(async () => {
            firstId = (await service.create({ name })).id;
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let secondResult: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          holding.then((cause) => {
            throw new Error('First create ended before checkpoint', { cause });
          }),
        ]);
        secondResult = second
          .run((service) => service.create({ name }))
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await witness(secondPid, firstPid, 'ShareRowExclusiveLock');
      } finally {
        release.resolve();
        await Promise.allSettled([holding, secondResult]);
      }
      await expect(holding).resolves.toBe(rollback ? abort : undefined);
      const global = await observer.globalPriceList.findUniqueOrThrow({
        where: { name },
      });
      if (rollback) {
        await expect(secondResult).resolves.toEqual(global);
        expect(await snapshot(firstId)).toEqual({
          global: null,
          prices: [],
          tenants: [],
          products: [],
        });
        await assertMatrix(
          global.id,
          i.foreignTenantId,
          i.foreignProductId,
          [],
        );
      } else {
        await expect(secondResult).resolves.toMatchObject({
          code: 'ENTITY_ALREADY_EXISTS',
          message: `GlobalPriceList "${name}" already exists`,
        });
        expect(global.id).toBe(firstId);
        await assertMatrix(global.id, i.tenantId, i.productId, [i.variantId]);
      }
      expect(await snapshot(i.globalPriceListId)).toEqual(prior);
    },
  );

  it.each(['shared', 'default', 'missing'])(
    'waits for %s lifecycle ownership before fresh validation',
    async (mode) => {
      const seed = await seedEditorialPostgres(observer, randomUUID());
      const id = seed.ids.globalPriceListId;
      const base = await open();
      const holderPid = await currentBackendPid(base);
      const remover = await open();
      const removerPid = await currentBackendPid(remover);
      const reached = signal();
      const release = signal();
      const holding = base.$transaction(async (tx) => {
        await lockCatalogLifecycle(
          tx,
          mode === 'shared' ? 'shared' : 'exclusive',
        );
        if (mode === 'default')
          await tx.globalPriceList.update({
            where: { id },
            data: { isDefault: true },
          });
        if (mode === 'missing')
          await tx.globalPriceList.delete({ where: { id } });
        reached.resolve();
        await release.promise;
      });
      let outcome: Promise<unknown> | undefined;
      try {
        await reached.promise;
        outcome = actor(remover)
          .run((p) => p.remove(id))
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(await waitForLockWait(observer, removerPid)).toContain(
          holderPid,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([holding, outcome]);
      }
      await expect(holding).resolves.toBeUndefined();
      if (mode === 'shared') await expect(outcome).resolves.toBeUndefined();
      else
        await expect(outcome).resolves.toMatchObject(
          mode === 'default'
            ? {
                code: 'DEFAULT_PRICE_LIST_PROTECTED',
                message: 'Cannot delete the default PUBLICO price list',
              }
            : {
                code: 'ENTITY_NOT_FOUND',
                message: `GlobalPriceList with id "${id}" not found`,
              },
        );
      const rows = await snapshot(id);
      if (mode === 'default') {
        expect(rows.global?.isDefault).toBe(true);
        expect(rows.prices).toHaveLength(1);
      } else
        expect(rows).toEqual({
          global: null,
          prices: [],
          tenants: [],
          products: [],
        });
    },
  );

  it.each([false, true])(
    'gates shared observation through cross-tenant cascades; rollback=%s',
    async (rollback) => {
      const seed = await seedEditorialPostgres(observer, randomUUID());
      const i = seed.ids;
      const id = i.globalPriceListId;
      const survivor = await observer.globalPriceList.create({
        data: { name: randomUUID() },
      });
      const foreignList = await observer.priceList.create({
        data: {
          tenantId: i.foreignTenantId,
          productId: i.foreignProductId,
          globalPriceListId: id,
          priceCents: 900,
        },
      });
      const foreignVariant = await observer.variant.create({
        data: {
          tenantId: i.foreignTenantId,
          productId: i.foreignProductId,
          name: 'Foreign',
          sku: randomUUID(),
          quantity: 0,
        },
      });
      const foreignPrice = await observer.variantPrice.create({
        data: {
          tenantId: i.foreignTenantId,
          variantId: foreignVariant.id,
          priceListId: foreignList.id,
          priceCents: 900,
        },
      });
      for (const [tenantId, productId, variantPriceId] of [
        [i.tenantId, i.productId, i.variantPriceId],
        [i.foreignTenantId, i.foreignProductId, foreignPrice.id],
      ]) {
        await observer.variantTierPrice.create({
          data: { tenantId, variantPriceId, minQuantity: 2, priceCents: 500 },
        });
        await observer.tenantCatalogPriceList.createMany({
          data: [id, survivor.id].map((globalPriceListId) => ({
            tenantId,
            globalPriceListId,
          })),
        });
        await observer.productCatalogPriceList.create({
          data: { tenantId, productId, globalPriceListId: id },
        });
      }
      const before = await snapshot(id);
      const unchanged = await snapshot(survivor.id);
      expect(before.prices).toHaveLength(2);
      expect(before.products).toHaveLength(2);
      expect(before.tenants).toHaveLength(2);
      expect(
        before.prices.every(
          (p) =>
            p.variantPrices.length === 1 &&
            p.variantPrices[0].tierPrices.length === 1,
        ),
      ).toBe(true);
      const writerBase = await open();
      const writerPid = await currentBackendPid(writerBase);
      const reader = await open();
      const readerPid = await currentBackendPid(reader);
      const writer = actor(writerBase, rollback ? i.tenantId : null);
      const reached = signal();
      const release = signal();
      const failure = new Error('outer rollback');
      const write = writer
        .run((p) =>
          writer.transaction(async () => {
            await expect(p.remove(id)).resolves.toBeUndefined();
            reached.resolve();
            await release.promise;
            if (rollback) throw failure;
          }),
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      let reading: Promise<unknown> | undefined;
      try {
        await reached.promise;
        reading = reader.$transaction(async (tx) => {
          await lockCatalogLifecycle(tx, 'shared');
          return tx.globalPriceList.findUnique({ where: { id } });
        });
        expect(await waitForLockWait(observer, readerPid)).toContain(writerPid);
      } finally {
        release.resolve();
        await Promise.allSettled([write, reading]);
      }
      await expect(write).resolves.toEqual(rollback ? failure : undefined);
      await expect(reading).resolves.toEqual(rollback ? before.global : null);
      await expect(snapshot(id)).resolves.toEqual(
        rollback
          ? before
          : { global: null, prices: [], tenants: [], products: [] },
      );
      await expect(snapshot(survivor.id)).resolves.toEqual(unchanged);
      for (const [tenantId, productId] of [
        [i.tenantId, i.productId],
        [i.foreignTenantId, i.foreignProductId],
      ]) {
        // Empty allowlist keeps its existing “all tenant-public lists” meaning.
        await expect(
          observer.productCatalogPriceList.count({
            where: { tenantId, productId },
          }),
        ).resolves.toBe(rollback ? 1 : 0);
        await expect(
          observer.tenantCatalogPriceList.count({
            where: { tenantId, globalPriceListId: survivor.id },
          }),
        ).resolves.toBe(1);
      }
    },
  );
});
