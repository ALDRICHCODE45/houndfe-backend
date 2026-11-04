import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient, Variant } from '@prisma/client';
import type { CatalogEditorialCore } from '../catalog-editorial/application/catalog-editorial-core';
import type { EditorialDocument } from '../catalog-editorial/domain/document';
import type { ProductsService } from './products.service';
import type { PriceListsService } from '../price-lists/price-lists.service';
import type { CreateVariantDto } from './dto/variant.dto';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { loadEditorialPostgresClient } from '../catalog-editorial/infrastructure/editorial-coordination-postgres-binding';
import {
  currentBackendPid,
  readVariantMembership,
  readVariantPrices,
  seedEditorialPostgres,
  waitForLockWait,
  type EditorialFixture,
} from '../catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

type Actor = {
  client: PrismaClient;
  inTransaction: <T>(work: () => Promise<T>) => Promise<T>;
  run: <T>(
    seed: EditorialFixture,
    work: (products: ProductsService, lists: PriceListsService) => Promise<T>,
  ) => Promise<T>;
};
type Latch = {
  client: PrismaClient;
  reached: Promise<void>;
  release(failure?: Error): void;
};

function unused<T>(label: string): T {
  // Test-only collaborator: every property access fails, never a silent no-op.
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`Unexpected live collaborator: ${label}`);
      },
    },
  ) as T;
}
function sqlText(args: unknown): string {
  if (Array.isArray(args)) {
    const [strings] = args as unknown[];
    return Array.isArray(strings) ? strings.join('?') : String(strings);
  }
  const sql = args as { sql?: unknown; strings?: unknown } | null;
  if (typeof sql?.sql === 'string') return sql.sql;
  return Array.isArray(sql?.strings) ? sql.strings.join('?') : '';
}
/**
 * Pauses ONE matching statement on this actor's own client before it is sent.
 * A pause between two statements of one transaction is equivalent to the
 * scheduler delaying the second statement: no lock is taken or released by it.
 * A failure releases the statement as a rejected query, so the surrounding
 * interactive transaction rolls back exactly as on a database error.
 */
function latch(
  base: PrismaClient,
  matches: (
    sql: string,
    model: string | undefined,
    operation: string,
  ) => boolean,
): Latch {
  let reach!: () => void;
  let release!: (failure?: Error) => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const gate = new Promise<void>(
    (resolve, reject) =>
      (release = (failure) => (failure ? reject(failure) : resolve())),
  );
  let armed = true;
  const client = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (armed && matches(sqlText(args), model, operation)) {
          armed = false;
          reach();
          await gate;
        }
        const result: unknown = await query(args);
        return result;
      },
    },
  });
  return { client: client as unknown as PrismaClient, reached, release };
}
/**
 * Exact PostgreSQL SQLSTATE of a rejected query. Raw queries surface it as
 * `meta.code` or, for PrismaClientUnknownRequestError, inside the engine's
 * `PostgresError { code: "…" }` text. No message heuristics: absent → undefined.
 */
function postgresSqlState(error: unknown): string | undefined {
  const e = error as { meta?: { code?: unknown }; message?: unknown };
  if (typeof e?.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.meta.code))
    return e.meta.code;
  return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(String(e?.message))?.[1];
}
function document(seed: EditorialFixture): EditorialDocument {
  return {
    commercialTitle: null,
    description: null,
    mediaRefs: [seed.ids.assetId],
    familyCode: seed.ids.familyId,
    values: [
      {
        code: seed.ids.definitionId,
        owner: 'product',
        variantId: null,
        type: 'single',
        value: seed.values.activeOptionCode,
      },
    ],
  };
}

describe('live Variant membership and stock coordination', () => {
  const opened: PrismaClient[] = [];
  let observer: PrismaClient;
  let freshSeed: () => Promise<EditorialFixture>;
  let actor: (client: PrismaClient) => Actor;
  let editorialFor: (client: PrismaClient) => CatalogEditorialCore;
  const open = async () => {
    const client = await loadEditorialPostgresClient();
    opened.push(client);
    return client;
  };

  beforeAll(async () => {
    // No skip/fallback: absent binding rejects BEFORE application imports.
    observer = await open();
    const { PrismaCatalogEditorial } =
      await import('../catalog-editorial/infrastructure/prisma-catalog-editorial');
    const { PrismaEditorialAuthority } =
      await import('../catalog-editorial/infrastructure/prisma-editorial-authority');
    const { createCoordinatedEditorialWriteAuthority } =
      await import('../catalog-editorial/infrastructure/prisma-coordinated-editorial-authority');
    const { ProductsService } = await import('./products.service');
    const { ProductStockJournal } =
      await import('./infrastructure/product-stock-journal');
    const { StockJournalWriter } =
      await import('../inventory/infrastructure/stock-journal.writer');
    const { PriceListsService } =
      await import('../price-lists/price-lists.service');
    const { PrismaProductRepository } =
      await import('./infrastructure/prisma-product.repository');
    const { TenantPrismaService } =
      await import('../shared/prisma/tenant-prisma.service');
    const { ClsService } = await import('nestjs-cls');
    const { randomUUID } = await import('node:crypto');
    const cls = new ClsService<TenantClsStore>(
      new AsyncLocalStorage<TenantClsStore>(),
    );
    freshSeed = () => seedEditorialPostgres(observer, randomUUID());
    editorialFor = (client) =>
      new PrismaCatalogEditorial(
        client,
        new PrismaEditorialAuthority(client),
        undefined,
        undefined,
        createCoordinatedEditorialWriteAuthority,
      );
    actor = (client) => {
      // Each actor owns one connection (connection_limit=1) and its own tenant client.
      const tenant = new TenantPrismaService(
        client as ConstructorParameters<typeof TenantPrismaService>[0],
        cls,
      );
      const repository = new PrismaProductRepository(
        tenant,
        unused('OutboxWriterService'),
        unused('IStockAlertStateRepository'),
      );
      const config = {
        get: (_key: string, fallback: string) => fallback,
      } as unknown as ConfigService;
      const products = new ProductsService(
        repository,
        unused('ProductsService root PrismaService'),
        unused('FilesService'),
        tenant,
        unused('SatCatalogService'),
        new ProductStockJournal(
          new StockJournalWriter(tenant, config),
          tenant,
          { user: { findUnique: () => Promise.resolve(null) } } as never,
          cls,
          config,
        ),
      );
      const lists = new PriceListsService(unused('global root'), tenant);
      return {
        client,
        inTransaction: (work) => tenant.runInTransaction(work),
        run: (seed, work) =>
          cls.runWith(
            {
              tenantId: seed.ids.tenantId,
              userId: seed.ids.userId,
              isSuperAdmin: false,
            },
            () => work(products, lists),
          ),
      };
    };
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((client) => client.$disconnect()));
  });

  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  async function lifecycleWait(pid: number, holder: number, mode: string) {
    expect(await waitForLockWait(observer, pid)).toContain(holder);
    const locks = await observer.$queryRaw<{ mode: string }[]>`
      SELECT mode FROM pg_locks WHERE pid = ${pid} AND NOT granted
        AND relation = 'global_price_lists'::regclass`;
    expect(locks).toEqual([{ mode }]);
  }

  describe('complete Product PATCH coordination', () => {
    async function snapshot(seed: EditorialFixture) {
      const { tenantId, productId } = seed.ids;
      return {
        product: await observer.product.findUnique({
          where: { id: productId },
          include: { catalogPriceLists: true, serviceDetail: true },
        }),
        prices: await observer.priceList.findMany({
          where: { tenantId, productId },
          orderBy: { id: 'asc' },
        }),
        membership: await readVariantMembership(observer, tenantId, productId),
      };
    }

    it.each(['lifecycle', 'tenant', 'product'])(
      'waits at the %s gate and merges the post-wait state',
      async (gateName) => {
        const seed = await freshSeed();
        const owner = await open();
        const waiterClient = await open();
        const ownerPid = await currentBackendPid(owner);
        const waiterPid = await currentBackendPid(waiterClient);
        const waiter = actor(waiterClient);
        const reached = signal();
        const release = signal();
        const holding = owner
          .$transaction(async (tx) => {
            if (gateName === 'lifecycle')
              await tx.$executeRaw`LOCK TABLE "global_price_lists" IN SHARE ROW EXCLUSIVE MODE`;
            else
              await tx.$executeRaw`LOCK TABLE "global_price_lists" IN SHARE MODE`;
            if (gateName === 'product') {
              await tx.$queryRaw`SELECT id FROM "tenants" WHERE id = ${seed.ids.tenantId} FOR SHARE`;
            } else {
              await tx.$queryRaw`SELECT id FROM "tenants" WHERE id = ${seed.ids.tenantId} FOR UPDATE`;
            }
            await tx.$queryRaw`SELECT id FROM "products" WHERE "tenantId" = ${seed.ids.tenantId} AND id = ${seed.ids.productId} FOR UPDATE`;
            await tx.product.update({
              where: { id: seed.ids.productId },
              data: { requiresPrescription: true },
            });
            if (gateName === 'tenant') {
              await tx.tenantCatalogPriceList.create({
                data: {
                  tenantId: seed.ids.tenantId,
                  globalPriceListId: seed.ids.globalPriceListId,
                },
              });
            }
            reached.resolve();
            await release.promise;
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        let updating: ReturnType<ProductsService['update']> | undefined;
        try {
          await Promise.race([
            reached.promise,
            holding.then((cause) => {
              throw new Error('Owner ended before checkpoint', { cause });
            }),
          ]);
          updating = waiter.run(seed, (products) =>
            products.update(seed.ids.productId, {
              name: 'After wait',
              ...(gateName === 'tenant'
                ? { supportedCatalogPriceListIds: [seed.ids.globalPriceListId] }
                : {}),
            }),
          );
          expect(await waitForLockWait(observer, waiterPid)).toContain(
            ownerPid,
          );
          if (gateName === 'lifecycle') {
            await lifecycleWait(waiterPid, ownerPid, 'ShareLock');
            const locks = await observer.$queryRaw<
              { relation: string }[]
            >`SELECT relation::regclass::text AS relation FROM pg_locks WHERE pid = ${waiterPid} AND relation IN ('tenants'::regclass, 'products'::regclass)`;
            expect(locks).toEqual([]);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([holding, updating]);
        }
        await expect(holding).resolves.toBeUndefined();
        await expect(updating).resolves.toMatchObject({
          name: 'After wait',
          requiresPrescription: true,
        });
        const after = await snapshot(seed);
        expect(after.product).toMatchObject({
          name: 'After wait',
          requiresPrescription: true,
        });
        if (gateName === 'tenant')
          expect(
            after.product?.catalogPriceLists.map(
              (row) => row.globalPriceListId,
            ),
          ).toEqual([seed.ids.globalPriceListId]);
      },
    );

    it.each([false, true])(
      'keeps full response under the gates and restores mixed state on response failure=%s',
      async (failResponse) => {
        const seed = await freshSeed();
        const before = await snapshot(seed);
        const firstClient = await open();
        const firstPid = await currentBackendPid(firstClient);
        const checkpoint = latch(
          firstClient,
          (_sql, model, operation) =>
            model === 'ProductImage' && operation === 'findMany',
        );
        const first = actor(checkpoint.client);
        const otherClient = await open();
        const otherPid = await currentBackendPid(otherClient);
        const other = actor(otherClient);
        const error = new Error('synthetic Product PATCH response failure');
        const updating = first.run(seed, (products) =>
          products.update(seed.ids.productId, {
            name: 'Mixed',
            supportedCatalogPriceListIds: [],
            useStock: false,
          }),
        );
        const settled = updating.then(
          (value) => value,
          (failure: unknown) => failure,
        );
        let competing: ReturnType<ProductsService['update']> | undefined;
        try {
          await Promise.race([
            checkpoint.reached,
            settled.then((cause) => {
              throw new Error('PATCH ended before response checkpoint', {
                cause,
              });
            }),
          ]);
          expect(await snapshot(seed)).toEqual(before);
          competing = other.run(seed, (products) =>
            products.update(seed.ids.productId, {
              description: 'Second writer',
            }),
          );
          expect(await waitForLockWait(observer, otherPid)).toContain(firstPid);
        } finally {
          checkpoint.release(failResponse ? error : undefined);
          await Promise.allSettled([settled, competing]);
        }
        await expect(competing).resolves.toMatchObject({
          description: 'Second writer',
        });
        if (failResponse) {
          await expect(updating).rejects.toThrow(
            'synthetic Product PATCH response failure',
          );
          const after = await snapshot(seed);
          expect(after.product?.name).toBe(before.product?.name);
          expect(after.product?.useStock).toBe(before.product?.useStock);
          expect(after.product?.catalogPriceLists).toEqual(
            before.product?.catalogPriceLists,
          );
          expect(after.prices).toEqual(before.prices);
          expect(after.membership.variants).toEqual(before.membership.variants);
        } else {
          await expect(updating).resolves.toMatchObject({
            name: 'Mixed',
            useStock: false,
          });
          expect(
            (await snapshot(seed)).membership.variants.every(
              (row) => row.minQuantity === 0,
            ),
          ).toBe(true);
        }
      },
    );

    it.each([false, true])(
      'holds Product until outer completion, allows unrelated progress, rollback=%s',
      async (rollback) => {
        const seed = await freshSeed();
        const before = await snapshot(seed);
        const unrelated = await observer.product.create({
          data: {
            tenantId: seed.ids.tenantId,
            name: 'Unrelated',
            sku: `${seed.ids.productId}-unrelated`,
          },
        });
        const ownerClient = await open();
        const ownerPid = await currentBackendPid(ownerClient);
        const waiterClient = await open();
        const waiterPid = await currentBackendPid(waiterClient);
        const owner = actor(ownerClient);
        const waiter = actor(waiterClient);
        const independent = actor(await open());
        const reached = signal();
        const release = signal();
        const error = new Error('synthetic Product PATCH outer rollback');
        const holding = owner
          .run(seed, (products) =>
            owner.inTransaction(async () => {
              await products.update(seed.ids.productId, {
                name: 'First writer',
              });
              reached.resolve();
              await release.promise;
              if (rollback) throw error;
            }),
          )
          .then(
            () => undefined,
            (failure: unknown) => failure,
          );
        let competing: ReturnType<ProductsService['update']> | undefined;
        try {
          await Promise.race([
            reached.promise,
            holding.then((cause) => {
              throw new Error('Owner ended before checkpoint', { cause });
            }),
          ]);
          expect(await snapshot(seed)).toEqual(before);
          competing = waiter.run(seed, (products) =>
            products.update(seed.ids.productId, {
              description: 'Waiting writer',
            }),
          );
          expect(await waitForLockWait(observer, waiterPid)).toContain(
            ownerPid,
          );
          await expect(
            independent.run(seed, (products) =>
              products.update(unrelated.id, { name: 'Unrelated completed' }),
            ),
          ).resolves.toMatchObject({ name: 'Unrelated completed' });
        } finally {
          release.resolve();
          await Promise.allSettled([holding, competing]);
        }
        await expect(holding).resolves.toBe(rollback ? error : undefined);
        await expect(competing).resolves.toMatchObject({
          name: rollback ? before.product?.name : 'First writer',
          description: 'Waiting writer',
        });
        const after = await snapshot(seed);
        expect(after.product?.name).toBe(
          rollback ? before.product?.name : 'First writer',
        );
        expect(after.prices).toEqual(before.prices);
        expect(after.membership.variants).toEqual(before.membership.variants);
      },
    );
  });

  const lifecycleTiers = [
    { minQuantity: 2, priceCents: 500 },
    { minQuantity: 5, priceCents: 300 },
  ];
  function upsertResponse(seed: EditorialFixture, name: string, price: number) {
    const margin = (value: number) => ({
      amountCents: value - 100,
      amountDecimal: (value - 100) / 100,
      percent: Math.round(((value - 100) / value) * 100),
    });
    return {
      id: seed.ids.variantPriceId,
      variantId: seed.ids.variantId,
      priceListId: seed.ids.priceListId,
      priceListName: name,
      priceCents: price,
      priceDecimal: price / 100,
      margin: margin(price),
      tierPrices: lifecycleTiers.map((tier) => ({
        id: expect.any(String) as unknown,
        ...tier,
        priceDecimal: tier.priceCents / 100,
        margin: margin(tier.priceCents),
      })),
    };
  }
  async function upsertSeed() {
    const seed = await freshSeed();
    await observer.variant.update({
      where: { id: seed.ids.variantId },
      data: { purchaseNetCostCents: 100 },
    });
    await observer.variantTierPrice.create({
      data: {
        tenantId: seed.ids.tenantId,
        variantPriceId: seed.ids.variantPriceId,
        minQuantity: 3,
        priceCents: 400,
      },
    });
    const { name } = await observer.globalPriceList.findUniqueOrThrow({
      where: { id: seed.ids.globalPriceListId },
    });
    return { seed, name };
  }

  async function addState(seed: EditorialFixture) {
    const where = {
      tenantId: seed.ids.tenantId,
      productId: seed.ids.productId,
    };
    return {
      membership: await readVariantMembership(
        observer,
        seed.ids.tenantId,
        seed.ids.productId,
      ),
      variants: await observer.variant.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      prices: await observer.variantPrice.findMany({
        where: {
          tenantId: seed.ids.tenantId,
          variant: { productId: seed.ids.productId },
        },
        include: { tierPrices: true },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function assertAdded(
    seed: EditorialFixture,
    result: Awaited<ReturnType<ProductsService['addVariant']>>,
  ) {
    const row = await observer.variant.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(result).toEqual({
      ...row,
      purchaseNetCostDecimal:
        row.purchaseNetCostCents == null
          ? null
          : row.purchaseNetCostCents / 100,
    });
    expect(row).toMatchObject({
      tenantId: seed.ids.tenantId,
      productId: seed.ids.productId,
      catalogPublishMode: 'INHERIT',
      onlineStockPresentation: null,
      onlineStockPresentationCustomQty: null,
    });
    const lists = await observer.priceList.findMany({
      where: { productId: seed.ids.productId },
      orderBy: { id: 'asc' },
    });
    const prices = await observer.variantPrice.findMany({
      where: { variantId: row.id },
      orderBy: { priceListId: 'asc' },
      include: { tierPrices: true },
    });
    expect(
      prices.map(
        ({ variantId, priceListId, tenantId, priceCents, tierPrices }) => ({
          variantId,
          priceListId,
          tenantId,
          priceCents,
          tierPrices,
        }),
      ),
    ).toEqual(
      lists.map(({ id }) => ({
        variantId: row.id,
        priceListId: id,
        tenantId: seed.ids.tenantId,
        priceCents: 0,
        tierPrices: [],
      })),
    );
  }

  it.each([false, true])(
    'adds after actual global deletion rollback=%s',
    async (rollback) => {
      const { seed } = await upsertSeed();
      const before = await addState(seed);
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      const reached = signal();
      const release = signal();
      const abort = new Error('delete before add rollback');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result:
        | Awaited<ReturnType<ProductsService['addVariant']>>
        | undefined;
      let adding: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before add checkpoint', { cause });
          }),
        ]);
        adding = endpoint
          .run(seed, async (p) => {
            result = await p.addVariant(seed.ids.productId, {
              name: 'Added',
              purchaseNetCostCents: 1234,
            });
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
        const locks = await observer.$queryRaw<{ mode: string }[]>`
        SELECT mode FROM pg_locks WHERE pid = ${endpointPid}
          AND relation = 'products'::regclass AND granted`;
        expect(locks).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, adding]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      await expect(adding).resolves.toBeUndefined();
      expect(result).toBeDefined();
      await assertAdded(seed, result!);
      const after = await addState(seed);
      expect(after.variants.filter((row) => row.id !== result!.id)).toEqual(
        before.variants,
      );
      expect(
        after.prices.filter((row) => row.variantId !== result!.id),
      ).toEqual(rollback ? before.prices : []);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
    },
  );

  it.each(['commit', 'rollback', 'enrich'])(
    'retains add lifecycle through %s',
    async (stage) => {
      const { seed } = await upsertSeed();
      const { seed: other } = await upsertSeed();
      // Exercise the parent-flag branch and prove it is rolled back with creation.
      await observer.product.update({
        where: { id: seed.ids.productId },
        data: { hasVariants: false, quantity: 7, minQuantity: 2 },
      });
      const before = await addState(seed);
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'Variant' && operation === 'create',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('add enrichment or outer abort');
      const globalAbort = new Error('delete rollback after add');
      const results: Awaited<ReturnType<ProductsService['addVariant']>>[] = [];
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            if (stage === 'enrich') {
              jest
                .spyOn(
                  p as unknown as {
                    enrichVariantCostResponse: (value: Variant) => unknown;
                  },
                  'enrichVariantCostResponse',
                )
                .mockImplementationOnce(() => {
                  throw abort;
                });
            }
            results.push(
              await p.addVariant(seed.ids.productId, {
                name: 'First',
                purchaseNetCostCents: 1234,
              }),
            );
            expect(results[0].purchaseNetCostDecimal).toBe(12.34);
            responded.resolve();
            await repeat.promise;
            results.push(
              await p.addVariant(seed.ids.productId, {
                name: 'Second',
                purchaseNetCostCents: 0,
              }),
            );
            expect(results[1].purchaseNetCostDecimal).toBe(0);
            repeated.resolve();
            await release.promise;
            if (stage === 'rollback') throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Add ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        const independent = await unrelated.run(other, (p) =>
          p.addVariant(other.ids.productId, { name: 'Independent' }),
        );
        await assertAdded(other, independent);
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release();
        if (stage !== 'enrich') {
          await Promise.race([responded.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
          repeat.resolve();
          await Promise.race([repeated.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
          await expect(addState(seed)).resolves.toEqual(before);
        }
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(
        stage === 'commit' ? undefined : abort,
      );
      await expect(deletion).resolves.toBe(globalAbort);
      const after = await addState(seed);
      if (stage === 'commit') {
        expect(results).toHaveLength(2);
        for (const result of results) await assertAdded(seed, result);
        expect(
          after.variants.filter((row) => !results.some((r) => r.id === row.id)),
        ).toEqual(before.variants);
        expect(
          after.prices.filter(
            (row) => !results.some((r) => r.id === row.variantId),
          ),
        ).toEqual(before.prices);
        await expect(
          observer.product.findUniqueOrThrow({
            where: { id: seed.ids.productId },
            select: {
              hasVariants: true,
              useLotsAndExpirations: true,
              quantity: true,
              minQuantity: true,
            },
          }),
        ).resolves.toEqual({
          hasVariants: true,
          useLotsAndExpirations: false,
          quantity: 0,
          minQuantity: 0,
        });
      } else expect(after).toEqual(before);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(1);
      const progress = await endpoint.run(seed, (p) =>
        p.addVariant(seed.ids.productId, { name: 'Progress' }),
      );
      await assertAdded(seed, progress);
    },
  );

  function updateResponse(before: Variant, name: string, cost: number) {
    return {
      ...before,
      name,
      purchaseNetCostCents: cost,
      purchaseNetCostDecimal: cost / 100,
      updatedAt: expect.any(Date) as unknown,
    };
  }
  it.each([false, true])(
    'updates after real global deletion rollback=%s',
    async (rollback) => {
      const { seed } = await upsertSeed();
      const before = await observer.variant.findUniqueOrThrow({
        where: { id: seed.ids.variantId },
      });
      const priceQuery = {
        where: { id: seed.ids.variantPriceId },
        include: { tierPrices: true },
      };
      const prices = await observer.variantPrice.findUniqueOrThrow(priceQuery);
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global before update');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before update checkpoint', {
              cause,
            });
          }),
        ]);
        result = endpoint
          .run(seed, (p) =>
            p.updateVariant(seed.ids.productId, seed.ids.variantId, {
              name: 'Changed',
              purchaseNetCostCents: 1234,
            }),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
        const locks = await observer.$queryRaw<{ mode: string }[]>`
        SELECT mode FROM pg_locks WHERE pid = ${endpointPid}
          AND relation = 'products'::regclass AND granted`;
        expect(locks).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, result]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      await expect(result).resolves.toEqual(
        updateResponse(before, 'Changed', 1234),
      );
      const after = await observer.variant.findUniqueOrThrow({
        where: { id: seed.ids.variantId },
      });
      expect(after).toEqual({
        ...before,
        name: 'Changed',
        purchaseNetCostCents: 1234,
        updatedAt: expect.any(Date) as unknown,
      });
      await expect(result).resolves.toEqual({
        ...after,
        purchaseNetCostDecimal: 12.34,
      });
      await expect(
        observer.variantPrice.findUnique(priceQuery),
      ).resolves.toEqual(rollback ? prices : null);
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? prices.tierPrices.length : 0);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
    },
  );

  it.each(['commit', 'rollback', 'enrich'])(
    'retains update lifecycle through %s',
    async (stage) => {
      const { seed } = await upsertSeed();
      const { seed: other } = await upsertSeed();
      const variantQuery = { where: { id: seed.ids.variantId } };
      const before = await observer.variant.findUniqueOrThrow(variantQuery);
      const otherBefore = await observer.variant.findUniqueOrThrow({
        where: { id: other.ids.variantId },
      });
      const priceQuery = {
        where: { id: seed.ids.variantPriceId },
        include: { tierPrices: true },
      };
      const prices = await observer.variantPrice.findUniqueOrThrow(priceQuery);
      const membership = () =>
        readVariantMembership(observer, seed.ids.tenantId, seed.ids.productId);
      const beforeMembership = await membership();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'Variant' && operation === 'update',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('update response or outer failure');
      const globalAbort = new Error('rollback following global deletion');
      let second:
        | Awaited<ReturnType<ProductsService['updateVariant']>>
        | undefined;
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            if (stage === 'enrich') {
              jest
                .spyOn(
                  p as unknown as {
                    enrichVariantCostResponse: (value: Variant) => unknown;
                  },
                  'enrichVariantCostResponse',
                )
                .mockImplementationOnce(() => {
                  throw abort;
                });
            }
            const first = await p.updateVariant(
              seed.ids.productId,
              seed.ids.variantId,
              { name: 'Changed', purchaseNetCostCents: 1234 },
            );
            expect(first).toEqual(updateResponse(before, 'Changed', 1234));
            responded.resolve();
            await repeat.promise;
            second = await p.updateVariant(
              seed.ids.productId,
              seed.ids.variantId,
              { name: 'Repeated', purchaseNetCostCents: 0 },
            );
            expect(second).toEqual(updateResponse(before, 'Repeated', 0));
            repeated.resolve();
            await release.promise;
            if (stage === 'rollback') throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Update ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        await expect(
          unrelated.run(other, (p) =>
            p.updateVariant(other.ids.productId, other.ids.variantId, {
              name: 'Other',
              purchaseNetCostCents: 200,
            }),
          ),
        ).resolves.toEqual(updateResponse(otherBefore, 'Other', 200));
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release();
        if (stage !== 'enrich') {
          await Promise.race([responded.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
          repeat.resolve();
          await Promise.race([repeated.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        }
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(
        stage === 'commit' ? undefined : abort,
      );
      await expect(deletion).resolves.toBe(globalAbort);
      const after = await observer.variant.findUniqueOrThrow(variantQuery);
      if (stage === 'commit') {
        expect(after).toEqual({
          ...before,
          name: 'Repeated',
          purchaseNetCostCents: 0,
          updatedAt: expect.any(Date) as unknown,
        });
        expect(second).toEqual({ ...after, purchaseNetCostDecimal: 0 });
      } else expect(after).toEqual(before);
      await expect(membership()).resolves.toEqual(beforeMembership);
      await expect(
        observer.variantPrice.findUnique(priceQuery),
      ).resolves.toEqual(prices);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(1);
      await expect(
        endpoint.run(seed, (p) =>
          p.updateVariant(seed.ids.productId, seed.ids.variantId, {
            name: 'Progress',
            purchaseNetCostCents: 500,
          }),
        ),
      ).resolves.toEqual(updateResponse(before, 'Progress', 500));
    },
  );

  async function bulkLifecycleSeed() {
    const { seed, name } = await upsertSeed();
    const [added, untouched] = await bulkContexts(seed);
    const query = {
      where: { tenantId: seed.ids.tenantId, variantId: seed.ids.variantId },
      include: { tierPrices: { orderBy: { minQuantity: 'asc' as const } } },
      orderBy: { priceListId: 'asc' as const },
    };
    const before = await observer.variantPrice.findMany(query);
    const names = await observer.priceList.findMany({
      where: { id: { in: [added, untouched] } },
      include: { globalPriceList: true },
    });
    const prices = [
      {
        priceListId: seed.ids.priceListId,
        priceCents: 1000,
        tierPrices: lifecycleTiers,
      },
      { priceListId: added, priceCents: 900 },
      { priceListId: seed.ids.priceListId, priceCents: 700 },
    ];
    const expected = (price = 700) =>
      [
        upsertResponse(seed, name, price),
        ...[added, untouched].map((id) => ({
          ...upsertResponse(
            seed,
            names.find((l) => l.id === id)!.globalPriceList.name,
            id === added ? 900 : 200,
          ),
          id:
            id === added
              ? (expect.any(String) as unknown)
              : before.find((r) => r.priceListId === id)!.id,
          priceListId: id,
          tierPrices: [],
        })),
      ].sort((a, b) => a.priceListName.localeCompare(b.priceListName));
    return { seed, added, untouched, query, before, prices, expected };
  }

  it.each([false, true])(
    'bulk waits for actual global deletion rollback=%s',
    async (rollback) => {
      const c = await bulkLifecycleSeed();
      const { seed } = c;
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global deletion before bulk');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before bulk checkpoint', { cause });
          }),
        ]);
        result = endpoint
          .run(seed, (p) =>
            p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
              prices: c.prices,
            }),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
        const locks = await observer.$queryRaw<{ mode: string }[]>`
        SELECT mode FROM pg_locks WHERE pid = ${endpointPid}
          AND relation = 'products'::regclass AND granted`;
        expect(locks).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, result]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      const after = await observer.variantPrice.findMany(c.query);
      if (rollback) {
        await expect(result).resolves.toEqual(c.expected());
        expect(after).toHaveLength(3);
        expect(
          after.find((r) => r.priceListId === seed.ids.priceListId),
        ).toMatchObject({
          id: seed.ids.variantPriceId,
          priceCents: 700,
          tierPrices: lifecycleTiers,
        });
        expect(
          after.find((r) => r.priceListId === seed.ids.priceListId)?.tierPrices,
        ).toHaveLength(2);
        expect(after.find((r) => r.priceListId === c.added)).toMatchObject({
          priceCents: 900,
          tierPrices: [],
        });
      } else {
        await expect(result).resolves.toMatchObject({
          code: 'ENTITY_NOT_FOUND',
          message: `PriceList with id "${seed.ids.priceListId}" not found`,
        });
        expect(after).toEqual(
          c.before.filter((r) => r.priceListId !== seed.ids.priceListId),
        );
      }
      expect(after.find((r) => r.priceListId === c.untouched)).toEqual(
        c.before.find((r) => r.priceListId === c.untouched),
      );
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? 2 : 0);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
      await expect(
        endpoint.run(seed, (p) =>
          p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
            prices: [],
          }),
        ),
      ).resolves.toEqual(
        rollback
          ? c.expected()
          : c.expected().filter((r) => r.priceListId === c.untouched),
      );
    },
  );

  it.each(['commit', 'rollback', 'result'])(
    'retains bulk lifecycle through %s',
    async (stage) => {
      const c = await bulkLifecycleSeed();
      const { seed } = c;
      const other = await upsertSeed();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'VariantPrice' && operation === 'findMany',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('bulk response or outer failure');
      const globalAbort = new Error('rollback following bulk deletion');
      let second:
        | Awaited<ReturnType<ProductsService['bulkUpsertVariantPrices']>>
        | undefined;
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            const first = await p.bulkUpsertVariantPrices(
              seed.ids.productId,
              seed.ids.variantId,
              { prices: c.prices },
            );
            expect(first).toEqual(c.expected());
            responded.resolve();
            await repeat.promise;
            second = await p.bulkUpsertVariantPrices(
              seed.ids.productId,
              seed.ids.variantId,
              {
                prices: [
                  { priceListId: seed.ids.priceListId, priceCents: 800 },
                ],
              },
            );
            expect(second).toEqual(c.expected(800));
            expect(second.map((r) => [r.id, r.tierPrices])).toEqual(
              first.map((r) => [r.id, r.tierPrices]),
            );
            repeated.resolve();
            await release.promise;
            if (stage === 'rollback') throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Bulk ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        await expect(
          unrelated.run(other.seed, (p) =>
            p.upsertVariantPrice(
              other.seed.ids.productId,
              other.seed.ids.variantId,
              other.seed.ids.priceListId,
              { priceCents: 1000, tierPrices: lifecycleTiers },
            ),
          ),
        ).resolves.toEqual(upsertResponse(other.seed, other.name, 1000));
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release(stage === 'result' ? abort : undefined);
        if (stage !== 'result') {
          await Promise.race([responded.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
          repeat.resolve();
          await Promise.race([repeated.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        }
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(
        stage === 'commit' ? undefined : abort,
      );
      await expect(deletion).resolves.toBe(globalAbort);
      const after = await observer.variantPrice.findMany(c.query);
      if (stage === 'commit') {
        expect(after).toHaveLength(3);
        for (const row of second!) {
          const stored = after.find((r) => r.priceListId === row.priceListId)!;
          expect(stored).toMatchObject({
            id: row.id,
            priceCents: row.priceCents,
            variantId: row.variantId,
            tenantId: seed.ids.tenantId,
            priceListId: row.priceListId,
          });
          expect(
            stored.tierPrices.map(({ id, minQuantity, priceCents }) => ({
              id,
              minQuantity,
              priceCents,
            })),
          ).toEqual(
            row.tierPrices.map(({ id, minQuantity, priceCents }) => ({
              id,
              minQuantity,
              priceCents,
            })),
          );
        }
      } else expect(after).toEqual(c.before);
      expect(after.find((r) => r.priceListId === c.untouched)).toEqual(
        c.before.find((r) => r.priceListId === c.untouched),
      );
      await expect(
        endpoint.run(seed, (p) =>
          p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
            prices: c.prices,
          }),
        ),
      ).resolves.toEqual(c.expected());
    },
  );

  it.each([false, true])(
    'upserts after global deletion rollback=%s',
    async (rollback) => {
      const { seed, name } = await upsertSeed();
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global deletion');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before checkpoint', { cause });
          }),
        ]);
        result = endpoint
          .run(seed, (p) =>
            p.upsertVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
              { priceCents: 1000, tierPrices: lifecycleTiers },
            ),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, result]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      if (rollback) {
        await expect(result).resolves.toEqual(upsertResponse(seed, name, 1000));
        await expect(
          observer.variantPrice.findUniqueOrThrow({
            where: { id: seed.ids.variantPriceId },
            include: { tierPrices: { orderBy: { minQuantity: 'asc' } } },
          }),
        ).resolves.toMatchObject({
          priceCents: 1000,
          tierPrices: lifecycleTiers,
        });
      } else {
        await expect(result).resolves.toMatchObject({
          code: 'ENTITY_NOT_FOUND',
          message: `PriceList with id "${seed.ids.priceListId}" not found`,
        });
        await expect(
          observer.variantPrice.count({
            where: { id: seed.ids.variantPriceId },
          }),
        ).resolves.toBe(0);
      }
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? 2 : 0);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
    },
  );

  it.each(['commit', 'rollback', 'result'])(
    'retains upsert lifecycle through %s',
    async (stage) => {
      const { seed, name } = await upsertSeed();
      const other = await upsertSeed();
      const query = {
        where: { id: seed.ids.variantPriceId },
        include: { tierPrices: { orderBy: { minQuantity: 'asc' as const } } },
      };
      const before = await observer.variantPrice.findUniqueOrThrow(query);
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'VariantPrice' && operation === 'findUnique',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('upsert failure');
      const globalAbort = new Error('rollback following deletion');
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            const first = await p.upsertVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
              { priceCents: 1000, tierPrices: lifecycleTiers },
            );
            expect(first).toEqual(upsertResponse(seed, name, 1000));
            responded.resolve();
            await repeat.promise;
            const second = await p.upsertVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
              { priceCents: 700 },
            );
            expect(second).toEqual(upsertResponse(seed, name, 700));
            expect(second.tierPrices).toEqual(first.tierPrices);
            repeated.resolve();
            await release.promise;
            if (stage === 'rollback') throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Upsert ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        await expect(
          unrelated.run(other.seed, (p) =>
            p.upsertVariantPrice(
              other.seed.ids.productId,
              other.seed.ids.variantId,
              other.seed.ids.priceListId,
              { priceCents: 1000, tierPrices: lifecycleTiers },
            ),
          ),
        ).resolves.toEqual(upsertResponse(other.seed, other.name, 1000));
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release(stage === 'result' ? abort : undefined);
        if (stage !== 'result') {
          await Promise.race([responded.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
          repeat.resolve();
          await Promise.race([repeated.promise, ended]);
          await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        }
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(
        stage === 'commit' ? undefined : abort,
      );
      await expect(deletion).resolves.toBe(globalAbort);
      const after = await observer.variantPrice.findUniqueOrThrow(query);
      if (stage === 'commit') {
        expect(after).toMatchObject({
          priceCents: 700,
          tierPrices: lifecycleTiers,
        });
        expect(after.tierPrices).toHaveLength(2);
      } else expect(after).toEqual(before);
      await expect(
        endpoint.run(seed, (p) =>
          p.upsertVariantPrice(
            seed.ids.productId,
            seed.ids.variantId,
            seed.ids.priceListId,
            { priceCents: 1000, tierPrices: lifecycleTiers },
          ),
        ),
      ).resolves.toEqual(upsertResponse(seed, name, 1000));
    },
  );

  it.each([false, true])(
    'removes variant membership after global lifecycle rollback=%s',
    async (rollback) => {
      const seed = await freshSeed();
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      await observer.variantTierPrice.create({
        data: {
          tenantId: seed.ids.tenantId,
          variantPriceId: seed.ids.variantPriceId,
          minQuantity: 2,
          priceCents: 700,
        },
      });
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global deletion');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before checkpoint', { cause });
          }),
        ]);
        result = endpoint
          .run(seed, (p) =>
            p.removeVariant(seed.ids.productId, seed.ids.variantId),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
        const locks = await observer.$queryRaw<{ mode: string }[]>`
          SELECT mode FROM pg_locks WHERE pid = ${endpointPid}
            AND relation = 'products'::regclass AND granted`;
        expect(locks).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, result]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      await expect(result).resolves.toBeUndefined();
      await expect(
        observer.variant.count({ where: { id: seed.ids.variantId } }),
      ).resolves.toBe(0);
      await expect(
        observer.product.findUniqueOrThrow({
          where: { id: seed.ids.productId },
          select: { hasVariants: true },
        }),
      ).resolves.toEqual({ hasVariants: false });
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
      await expect(
        observer.variantPrice.count({
          where: { id: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(0);
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(0);
    },
  );

  it.each([false, true])(
    'retains membership lifecycle through ambient rollback=%s',
    async (rollback) => {
      const seed = await freshSeed();
      const other = await freshSeed();
      await observer.variantTierPrice.create({
        data: {
          tenantId: seed.ids.tenantId,
          variantPriceId: seed.ids.variantPriceId,
          minQuantity: 2,
          priceCents: 700,
        },
      });
      const query = {
        where: { id: seed.ids.variantPriceId },
        include: { tierPrices: true },
      };
      const before = await observer.variantPrice.findUniqueOrThrow(query);
      const membership = () =>
        readVariantMembership(observer, seed.ids.tenantId, seed.ids.productId);
      const beforeMembership = await membership();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'Variant' && operation === 'delete',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('rollback variant deletion');
      const globalAbort = new Error('rollback following global deletion');
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            await expect(
              p.removeVariant(seed.ids.productId, seed.ids.variantId),
            ).resolves.toBeUndefined();
            responded.resolve();
            await repeat.promise;
            await expect(
              p.removeVariant(seed.ids.productId, seed.ids.variantId),
            ).rejects.toMatchObject({
              code: 'ENTITY_NOT_FOUND',
              message: `Variant with id "${seed.ids.variantId}" not found`,
            });
            repeated.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Endpoint ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        await expect(
          unrelated.run(other, (p) =>
            p.removeVariant(other.ids.productId, other.ids.variantId),
          ),
        ).resolves.toBeUndefined();
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release();
        await Promise.race([responded.promise, ended]);
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        repeat.resolve();
        await Promise.race([repeated.promise, ended]);
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(rollback ? abort : undefined);
      await expect(deletion).resolves.toBe(globalAbort);
      if (rollback)
        await expect(membership()).resolves.toEqual(beforeMembership);
      else {
        await expect(
          observer.variant.count({ where: { id: seed.ids.variantId } }),
        ).resolves.toBe(0);
        await expect(
          observer.product.findUniqueOrThrow({
            where: { id: seed.ids.productId },
            select: { hasVariants: true },
          }),
        ).resolves.toEqual({ hasVariants: false });
      }
      await expect(observer.variantPrice.findUnique(query)).resolves.toEqual(
        rollback ? before : null,
      );
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? before.tierPrices.length : 0);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(1);
      const progress = endpoint.run(seed, (p) =>
        p.removeVariant(seed.ids.productId, seed.ids.variantId),
      );
      if (rollback) await expect(progress).resolves.toBeUndefined();
      else
        await expect(progress).rejects.toMatchObject({
          code: 'ENTITY_NOT_FOUND',
          message: `Variant with id "${seed.ids.variantId}" not found`,
        });
    },
  );

  it.each([false, true])(
    'deletes a variant price after global lifecycle rollback=%s',
    async (rollback) => {
      const seed = await freshSeed();
      const remover = actor(await open());
      const endpoint = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const endpointPid = await currentBackendPid(endpoint.client);
      await observer.variantTierPrice.create({
        data: {
          tenantId: seed.ids.tenantId,
          variantPriceId: seed.ids.variantPriceId,
          minQuantity: 2,
          priceCents: 700,
        },
      });
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global deletion');
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let result: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((cause) => {
            throw new Error('Deletion ended before checkpoint', { cause });
          }),
        ]);
        result = endpoint
          .run(seed, (p) =>
            p.removeVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
            ),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(endpointPid, removerPid, 'ShareLock');
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, result]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      if (rollback) await expect(result).resolves.toBeUndefined();
      else
        await expect(result).resolves.toMatchObject({
          code: 'ENTITY_NOT_FOUND',
          message: `PriceList with id "${seed.ids.priceListId}" not found`,
        });
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
      await expect(
        observer.variantPrice.count({
          where: { id: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(0);
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(0);
    },
  );

  it.each([false, true])(
    'retains variant deletion gates through ambient rollback=%s',
    async (rollback) => {
      const seed = await freshSeed();
      const other = await freshSeed();
      await observer.variantTierPrice.create({
        data: {
          tenantId: seed.ids.tenantId,
          variantPriceId: seed.ids.variantPriceId,
          minQuantity: 2,
          priceCents: 700,
        },
      });
      const query = {
        where: { id: seed.ids.variantPriceId },
        include: { tierPrices: true },
      };
      const before = await observer.variantPrice.findUniqueOrThrow(query);
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'VariantPrice' && operation === 'delete',
      );
      const endpoint = actor(held.client);
      const endpointPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const responded = signal();
      const repeat = signal();
      const repeated = signal();
      const release = signal();
      const abort = new Error('rollback variant deletion');
      const globalAbort = new Error('rollback following global deletion');
      const writing = endpoint
        .run(seed, (p) =>
          endpoint.inTransaction(async () => {
            await expect(
              p.removeVariantPrice(
                seed.ids.productId,
                seed.ids.variantId,
                seed.ids.priceListId,
              ),
            ).resolves.toBeUndefined();
            responded.resolve();
            await repeat.promise;
            await expect(
              p.removeVariantPrice(
                seed.ids.productId,
                seed.ids.variantId,
                seed.ids.priceListId,
              ),
            ).rejects.toMatchObject({
              code: 'ENTITY_NOT_FOUND',
              message: `VariantPrice with id "${seed.ids.variantId}:${seed.ids.priceListId}" not found`,
            });
            repeated.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const ended = writing.then((cause) => {
        throw new Error('Endpoint ended before checkpoint', { cause });
      });
      let deletion: Promise<unknown> | undefined;
      try {
        await Promise.race([held.reached, ended]);
        await expect(
          unrelated.run(other, (p) =>
            p.removeVariantPrice(
              other.ids.productId,
              other.ids.variantId,
              other.ids.priceListId,
            ),
          ),
        ).resolves.toBeUndefined();
        deletion = remover
          .run(seed, (_p, lists) =>
            remover.inTransaction(async () => {
              await lists.remove(seed.ids.globalPriceListId);
              throw globalAbort;
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        held.release();
        await Promise.race([responded.promise, ended]);
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
        repeat.resolve();
        await Promise.race([repeated.promise, ended]);
        await lifecycleWait(removerPid, endpointPid, 'ShareRowExclusiveLock');
      } finally {
        held.release();
        repeat.resolve();
        release.resolve();
        await Promise.allSettled([writing, deletion, ended]);
      }
      await expect(writing).resolves.toBe(rollback ? abort : undefined);
      await expect(deletion).resolves.toBe(globalAbort);
      await expect(observer.variantPrice.findUnique(query)).resolves.toEqual(
        rollback ? before : null,
      );
      await expect(
        observer.variantTierPrice.count({
          where: { variantPriceId: seed.ids.variantPriceId },
        }),
      ).resolves.toBe(rollback ? before.tierPrices.length : 0);
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(1);
    },
  );

  it.each([false, true])(
    'observes actual global deletion after lifecycle wait, rollback=%s',
    async (rollback) => {
      const seed = await freshSeed();
      const remover = actor(await open());
      const updater = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const updaterPid = await currentBackendPid(updater.client);
      const reached = signal();
      const release = signal();
      const abort = new Error('rollback global deletion');
      const where = { id: seed.ids.priceListId };
      const before = await observer.priceList.findUniqueOrThrow({
        where,
        include: { tierPrices: true },
      });
      const deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            reached.resolve();
            await release.promise;
            if (rollback) throw abort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let update: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          deletion.then((e) => {
            if (e)
              throw new Error('Deletion failed before checkpoint', {
                cause: e,
              });
          }),
        ]);
        update = updater
          .run(seed, (p) =>
            p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
          )
          .then(
            (result) => result,
            (error: unknown) => error,
          );
        await lifecycleWait(updaterPid, removerPid, 'ShareLock');
      } finally {
        release.resolve();
        await Promise.allSettled([deletion, update]);
      }
      await expect(deletion).resolves.toBe(rollback ? abort : undefined);
      if (rollback) {
        await expect(update).resolves.toMatchObject({
          id: seed.ids.priceListId,
          priceCents: before.priceCents,
          tierPrices: before.tierPrices,
        });
        const after = await observer.priceList.findUniqueOrThrow({
          where,
          include: { tierPrices: true },
        });
        expect(after).toEqual({ ...before, updatedAt: after.updatedAt });
      } else {
        await expect(update).resolves.toMatchObject({
          code: 'ENTITY_NOT_FOUND',
          message: `PriceList with id "${seed.ids.priceListId}" not found`,
        });
        await expect(
          observer.priceList.findUnique({ where }),
        ).resolves.toBeNull();
      }
      await expect(
        observer.globalPriceList.count({
          where: { id: seed.ids.globalPriceListId },
        }),
      ).resolves.toBe(rollback ? 1 : 0);
    },
  );

  it('holds lifecycle through response and ambient rollback, with shared progress and queued deletion', async () => {
    const seed = await freshSeed();
    const other = await freshSeed();
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) =>
        model === 'PriceList' && operation === 'update',
    );
    const writer = actor(held.client);
    const writerPid = await currentBackendPid(base);
    const remover = actor(await open());
    const removerPid = await currentBackendPid(remover.client);
    const unrelated = actor(await open());
    const responded = signal();
    const repeat = signal();
    const repeated = signal();
    const release = signal();
    const abort = new Error('rollback update');
    const removeAbort = new Error('rollback following deletion');
    const where = { id: seed.ids.priceListId };
    const before = await observer.priceList.findUniqueOrThrow({
      where,
      include: { tierPrices: true },
    });
    const writing = writer
      .run(seed, (p) =>
        writer.inTransaction(async () => {
          await expect(
            p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {
              priceCents: 0,
              tierPrices: [{ minQuantity: 0, priceCents: 0 }],
            }),
          ).resolves.toMatchObject({
            priceCents: 0,
            tierPrices: [{ minQuantity: 0, priceCents: 0 }],
          });
          responded.resolve();
          await repeat.promise;
          await expect(
            p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {
              priceCents: 900,
            }),
          ).resolves.toMatchObject({ priceCents: 900 });
          repeated.resolve();
          await release.promise;
          throw abort;
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let deletion: Promise<unknown> | undefined;
    try {
      await Promise.race([
        held.reached,
        writing.then((e) => {
          throw e;
        }),
      ]);
      // Shared writers progress before an exclusive waiter enters the queue.
      await expect(
        unrelated.run(other, (p) =>
          p.updatePriceList(other.ids.productId, other.ids.priceListId, {
            priceCents: 0,
          }),
        ),
      ).resolves.toMatchObject({ priceCents: 0 });
      deletion = remover
        .run(seed, (_p, lists) =>
          remover.inTransaction(async () => {
            await lists.remove(seed.ids.globalPriceListId);
            throw removeAbort;
          }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await lifecycleWait(removerPid, writerPid, 'ShareRowExclusiveLock');
      held.release();
      await Promise.race([
        responded.promise,
        writing.then((e) => {
          throw e;
        }),
      ]);
      await lifecycleWait(removerPid, writerPid, 'ShareRowExclusiveLock');
      repeat.resolve();
      await Promise.race([
        repeated.promise,
        writing.then((e) => {
          throw e;
        }),
      ]);
      await lifecycleWait(removerPid, writerPid, 'ShareRowExclusiveLock');
    } finally {
      held.release();
      repeat.resolve();
      release.resolve();
      await Promise.allSettled([writing, deletion]);
    }
    await expect(writing).resolves.toBe(abort);
    await expect(deletion).resolves.toBe(removeAbort);
    await expect(
      observer.priceList.findUniqueOrThrow({
        where,
        include: { tierPrices: true },
      }),
    ).resolves.toEqual(before);
    await expect(
      observer.globalPriceList.count({
        where: { id: seed.ids.globalPriceListId },
      }),
    ).resolves.toBe(1);
    await expect(
      writer.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      ),
    ).resolves.toMatchObject({ priceCents: before.priceCents });
  });

  it('serializes add/remove behind an open editorial write and leaves other Products free', async () => {
    const seed = await freshSeed();
    const other = await freshSeed();
    const editorialBase = await open();
    const held = latch(editorialBase, (sql) =>
      sql.includes('INSERT INTO "catalog_editorial_states"'),
    );
    const editorialPid = await currentBackendPid(editorialBase);
    const remover = actor(await open());
    const adder = actor(await open());
    const unrelated = actor(await open());
    const removerPid = await currentBackendPid(remover.client);
    const adderPid = await currentBackendPid(adder.client);
    const scope = {
      actorId: seed.ids.userId,
      tenantId: seed.ids.tenantId,
      productId: seed.ids.productId,
    };

    const create = editorialFor(held.client).create(scope, {
      expectedCycle: null,
      idempotencyKey: 'membership-gate',
      document: document(seed),
    });
    const removal = held.reached.then(() =>
      remover.run(seed, (p) =>
        p.removeVariant(seed.ids.productId, seed.ids.variantId),
      ),
    );
    let addition: Promise<{ id: string }> | undefined;
    try {
      await held.reached;
      // Witness: both membership writers wait on the editorial backend's Product gate.
      expect(await waitForLockWait(observer, removerPid)).toContain(
        editorialPid,
      );
      addition = adder.run(seed, (p) =>
        p.addVariant(seed.ids.productId, {
          name: 'Added live variant',
        } as CreateVariantDto),
      );
      // Row-lock queueing: the second waiter may be reported blocked by the first
      // queued waiter (tuple lock) rather than the holder; both are behind the gate.
      const adderBlockers = await waitForLockWait(observer, adderPid);
      expect(adderBlockers.length).toBeGreaterThan(0);
      expect([editorialPid, removerPid]).toEqual(
        expect.arrayContaining(adderBlockers),
      );
      // A different qualified Product is not behind that gate.
      await expect(
        unrelated.run(other, (p) =>
          p.removeVariant(other.ids.productId, other.ids.variantId),
        ),
      ).resolves.toBeUndefined();
    } finally {
      held.release();
      // Drain every actor so a failed assertion cannot leak activity into later tests.
      await Promise.allSettled([create, removal, addition]);
    }
    await expect(create).resolves.toMatchObject({
      cycle: 1,
      draft: { revision: 1 },
    });
    await expect(removal).resolves.toBeUndefined();
    const added = await addition;

    const membership = await readVariantMembership(
      observer,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    expect(membership.variants.map((v) => v.id)).toEqual([added.id]);
    expect(membership.products[0]).toMatchObject({
      hasVariants: true,
      quantity: 0,
      minQuantity: 0,
    });
    await expect(
      readVariantPrices(observer, seed.ids.tenantId, added.id),
    ).resolves.toEqual([
      expect.objectContaining({
        priceListId: seed.ids.priceListId,
        priceCents: 0,
      }),
    ]);
    await expect(
      readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
    ).resolves.toEqual([]);
    const otherMembership = await readVariantMembership(
      observer,
      other.ids.tenantId,
      other.ids.productId,
    );
    expect(otherMembership.variants).toEqual([]);
    expect(otherMembership.products[0]).toMatchObject({ hasVariants: false });
  });

  it('rolls back a Variant INSERT that already executed when addVariant fails late', async () => {
    const seed = await freshSeed();
    const base = await open();
    const failing = latch(
      base,
      (_sql, model, operation) =>
        model === 'VariantPrice' && operation === 'createMany',
    );
    const adder = actor(failing.client);
    const adderPid = await currentBackendPid(base);
    const before = await readVariantMembership(
      observer,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    const addition = adder.run(seed, (p) =>
      p.addVariant(seed.ids.productId, {
        name: 'Rolled back variant',
      } as CreateVariantDto),
    );
    const settled = addition.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await failing.reached;
      // Witness: the INSERT ran inside the open transaction (row-exclusive lock held).
      const locks = await observer.$queryRaw<{ mode: string }[]>`
        SELECT l."mode" FROM pg_locks l JOIN pg_class c ON c."oid" = l."relation"
        WHERE l."pid" = ${adderPid} AND c."relname" = 'variants'`;
      expect(locks.map((l) => l.mode)).toContain('RowExclusiveLock');
    } finally {
      failing.release(new Error('injected late failure'));
      await settled;
    }
    await expect(settled).resolves.toEqual(new Error('injected late failure'));

    const membership = await readVariantMembership(
      observer,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    // Every observed Product flag/quantity and the Variant set are unchanged.
    expect(membership).toEqual(before);
    const prices = await observer.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS "count" FROM "variant_prices" WHERE "tenantId" = ${seed.ids.tenantId}`;
    expect(Number(prices[0].count)).toBe(1);
    // The Product gate was released: a removal proceeds immediately.
    const remover = actor(await open());
    await expect(
      remover.run(seed, (p) =>
        p.removeVariant(seed.ids.productId, seed.ids.variantId),
      ),
    ).resolves.toBeUndefined();
  });

  async function bulkContexts(seed: EditorialFixture) {
    const ids: string[] = [];
    for (const name of ['Bulk new', 'Bulk untouched']) {
      const global = await observer.globalPriceList.create({
        data: { name: `${name}-${seed.ids.productId}` },
      });
      const list = await observer.priceList.create({
        data: {
          tenantId: seed.ids.tenantId,
          productId: seed.ids.productId,
          globalPriceListId: global.id,
          priceCents: 200,
        },
      });
      ids.push(list.id);
    }
    await observer.variantPrice.create({
      data: {
        tenantId: seed.ids.tenantId,
        variantId: seed.ids.variantId,
        priceListId: ids[1],
        priceCents: 200,
      },
    });
    return ids;
  }

  it('gates bulk fresh costs, duplicate writes and the complete multi-list response', async () => {
    const seed = await freshSeed();
    const other = await freshSeed();
    const [newList, untouched] = await bulkContexts(seed);
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) => model === 'Variant' && operation === 'update',
    );
    const holderPid = await currentBackendPid(base);
    const updaterBase = await open();
    const response = latch(
      updaterBase,
      (_sql, model, operation) =>
        model === 'VariantPrice' && operation === 'findMany',
    );
    const updater = actor(response.client);
    const updaterPid = await currentBackendPid(updaterBase);
    const waiter = actor(await open());
    const waiterPid = await currentBackendPid(waiter.client);
    const unrelated = actor(await open());
    const holding = held.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
      await tx.variant.update({
        where: { id: seed.ids.variantId },
        data: { purchaseNetCostCents: 333 },
      });
    });
    let update:
      | ReturnType<ProductsService['bulkUpsertVariantPrices']>
      | undefined;
    let waiting: ReturnType<ProductsService['updatePriceList']> | undefined;
    try {
      await held.reached;
      update = updater.run(seed, (p) =>
        p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
          prices: [
            {
              priceListId: seed.ids.priceListId,
              priceCents: 1000,
              tierPrices: [{ minQuantity: 2, priceCents: 500 }],
            },
            { priceListId: newList, priceCents: 900 },
            { priceListId: seed.ids.priceListId, priceCents: 700 },
          ],
        }),
      );
      expect(await waitForLockWait(observer, updaterPid)).toContain(holderPid);
      await expect(
        unrelated.run(other, (p) =>
          p.bulkUpsertVariantPrices(other.ids.productId, other.ids.variantId, {
            prices: [{ priceListId: other.ids.priceListId, priceCents: 0 }],
          }),
        ),
      ).resolves.toEqual([expect.objectContaining({ priceCents: 0 })]);
      held.release();
      await response.reached;
      waiting = waiter.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      );
      expect(await waitForLockWait(observer, waiterPid)).toContain(updaterPid);
    } finally {
      held.release();
      response.release();
      await Promise.allSettled([holding, update, waiting]);
    }
    await expect(holding).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ id: seed.ids.priceListId });
    const result = await update;
    expect(result?.map((r) => r.priceListId).sort()).toEqual(
      [seed.ids.priceListId, newList, untouched].sort(),
    );
    expect(
      result?.find((r) => r.priceListId === seed.ids.priceListId),
    ).toMatchObject({
      priceCents: 700,
      margin: { amountCents: 367 },
      tierPrices: [
        { minQuantity: 2, priceCents: 500, margin: { amountCents: 167 } },
      ],
    });
    expect(result?.find((r) => r.priceListId === newList)).toMatchObject({
      priceCents: 900,
      tierPrices: [],
    });
    expect(result?.find((r) => r.priceListId === untouched)).toMatchObject({
      priceCents: 200,
    });
    const persisted = await observer.variantPrice.findMany({
      where: { tenantId: seed.ids.tenantId, variantId: seed.ids.variantId },
      include: { tierPrices: true },
    });
    expect(persisted).toHaveLength(3);
    expect(
      persisted.find((r) => r.priceListId === seed.ids.priceListId),
    ).toMatchObject({
      priceCents: 700,
      tierPrices: [{ minQuantity: 2, priceCents: 500 }],
    });
    expect(persisted.find((r) => r.priceListId === newList)).toMatchObject({
      priceCents: 900,
    });
    expect(persisted.find((r) => r.priceListId === untouched)).toMatchObject({
      priceCents: 200,
    });
  });

  it.each(['later-item', 'response', 'ambient'])(
    'rolls back the entire bulk batch on %s failure and releases the gate',
    async (stage) => {
      const seed = await freshSeed();
      const [newList] = await bulkContexts(seed);
      const query = {
        where: { tenantId: seed.ids.tenantId, variantId: seed.ids.variantId },
        include: { tierPrices: true },
        orderBy: { priceListId: 'asc' as const },
      };
      const before = await observer.variantPrice.findMany(query);
      const base = await open();
      let writes = 0;
      let gates = 0;
      const held = latch(base, (sql, model, operation) => {
        if (stage === 'later-item')
          return (
            model === 'VariantPrice' && operation === 'upsert' && ++writes === 2
          );
        if (stage === 'response')
          return model === 'VariantPrice' && operation === 'findMany';
        return (
          sql.includes('FROM "products"') &&
          sql.includes('FOR UPDATE') &&
          ++gates === 2
        );
      });
      const writer = actor(held.client);
      const writerPid = await currentBackendPid(base);
      const waiter = actor(await open());
      const waiterPid = await currentBackendPid(waiter.client);
      const write = writer.run(seed, (p) =>
        writer.inTransaction(async () => {
          await p.bulkUpsertVariantPrices(
            seed.ids.productId,
            seed.ids.variantId,
            {
              prices: [
                {
                  priceListId: newList,
                  priceCents: 0,
                  tierPrices: [{ minQuantity: 0, priceCents: 0 }],
                },
                {
                  priceListId: seed.ids.priceListId,
                  priceCents: 1,
                  tierPrices: [{ minQuantity: 2, priceCents: 1 }],
                },
              ],
            },
          );
          if (stage === 'ambient')
            await p.bulkUpsertVariantPrices(
              seed.ids.productId,
              seed.ids.variantId,
              { prices: [] },
            );
        }),
      );
      const outcome = write.then(
        () => null,
        (error: unknown) => error,
      );
      let waiting: ReturnType<ProductsService['updatePriceList']> | undefined;
      try {
        await held.reached;
        waiting = waiter.run(seed, (p) =>
          p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
        );
        expect(await waitForLockWait(observer, waiterPid)).toContain(writerPid);
      } finally {
        held.release(new Error('bulk failure'));
        await Promise.allSettled([outcome, waiting]);
      }
      await expect(outcome).resolves.toEqual(new Error('bulk failure'));
      await expect(waiting).resolves.toMatchObject({
        id: seed.ids.priceListId,
      });
      await expect(observer.variantPrice.findMany(query)).resolves.toEqual(
        before,
      );
      await expect(
        waiter.run(seed, (p) =>
          p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
            prices: [],
          }),
        ),
      ).resolves.toHaveLength(2);
    },
  );

  it.each(['Variant', 'PriceList'])(
    'bulk observes cooperating %s disappearance after waiting',
    async (entity) => {
      const seed = await freshSeed();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) => model === entity && operation === 'delete',
      );
      const holderPid = await currentBackendPid(base);
      const updater = actor(await open());
      const updaterPid = await currentBackendPid(updater.client);
      const holding = held.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
        if (entity === 'Variant')
          await tx.variant.delete({ where: { id: seed.ids.variantId } });
        else await tx.priceList.delete({ where: { id: seed.ids.priceListId } });
      });
      let outcome: Promise<unknown> | undefined;
      try {
        await held.reached;
        outcome = updater
          .run(seed, (p) =>
            p.bulkUpsertVariantPrices(seed.ids.productId, seed.ids.variantId, {
              prices: [{ priceListId: seed.ids.priceListId, priceCents: 0 }],
            }),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(await waitForLockWait(observer, updaterPid)).toContain(
          holderPid,
        );
      } finally {
        held.release();
        await Promise.allSettled([holding, outcome]);
      }
      await expect(holding).resolves.toBeUndefined();
      await expect(outcome).resolves.toMatchObject({
        code: 'ENTITY_NOT_FOUND',
        message: `${entity} with id "${entity === 'Variant' ? seed.ids.variantId : seed.ids.priceListId}" not found`,
      });
      await expect(
        readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
      ).resolves.toEqual([]);
    },
  );

  it.each([null, 250])(
    'keeps single-upsert observation and response gated with Variant cost=%s',
    async (variantCost) => {
      const seed = await freshSeed();
      const other = await freshSeed();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'Variant' && operation === 'update',
      );
      const holderPid = await currentBackendPid(base);
      const updaterBase = await open();
      const response = latch(
        updaterBase,
        (_sql, model, operation) =>
          model === 'VariantPrice' && operation === 'findUnique',
      );
      const updater = actor(response.client);
      const updaterPid = await currentBackendPid(updaterBase);
      const waiter = actor(await open());
      const waiterPid = await currentBackendPid(waiter.client);
      const unrelated = actor(await open());
      const holding = held.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
        await tx.product.update({
          where: { id: seed.ids.productId },
          data: { purchaseNetCostCents: 700 },
        });
        await tx.variant.update({
          where: { id: seed.ids.variantId },
          data: { purchaseNetCostCents: variantCost },
        });
      });
      let update: ReturnType<ProductsService['upsertVariantPrice']> | undefined;
      let waiting: ReturnType<ProductsService['updatePriceList']> | undefined;
      try {
        await held.reached;
        update = updater.run(seed, (p) =>
          p.upsertVariantPrice(
            seed.ids.productId,
            seed.ids.variantId,
            seed.ids.priceListId,
            {
              priceCents: 1000,
              tierPrices: [{ minQuantity: 2, priceCents: 500 }],
            },
          ),
        );
        expect(await waitForLockWait(observer, updaterPid)).toContain(
          holderPid,
        );
        await expect(
          unrelated.run(other, (p) =>
            p.upsertVariantPrice(
              other.ids.productId,
              other.ids.variantId,
              other.ids.priceListId,
              { priceCents: 0 },
            ),
          ),
        ).resolves.toMatchObject({ priceCents: 0 });
        held.release();
        await response.reached;
        waiting = waiter.run(seed, (p) =>
          p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
        );
        expect(await waitForLockWait(observer, waiterPid)).toContain(
          updaterPid,
        );
      } finally {
        held.release();
        response.release();
        await Promise.allSettled([holding, update, waiting]);
      }
      await expect(holding).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({
        id: seed.ids.priceListId,
      });
      await expect(update).resolves.toMatchObject({
        priceCents: 1000,
        margin: { amountCents: 1000 - (variantCost ?? 700) },
        tierPrices: [
          {
            minQuantity: 2,
            priceCents: 500,
            margin: { amountCents: 500 - (variantCost ?? 700) },
          },
        ],
      });
      await expect(
        observer.variantPrice.findFirst({
          where: { id: seed.ids.variantPriceId },
          include: { tierPrices: true },
        }),
      ).resolves.toMatchObject({
        priceCents: 1000,
        tierPrices: [{ minQuantity: 2, priceCents: 500 }],
      });
    },
  );

  it('rolls back single-upsert price and tier replacement after ambient late failure', async () => {
    const seed = await freshSeed();
    const where = { id: seed.ids.variantPriceId, tenantId: seed.ids.tenantId };
    const before = await observer.variantPrice.update({
      where,
      data: {
        tierPrices: {
          create: {
            tenantId: seed.ids.tenantId,
            minQuantity: 3,
            priceCents: 900,
          },
        },
      },
      include: { tierPrices: true },
    });
    const base = await open();
    let gates = 0;
    const held = latch(
      base,
      (sql) =>
        sql.includes('FROM "products"') &&
        sql.includes('FOR UPDATE') &&
        ++gates === 2,
    );
    const writer = actor(held.client);
    const writerPid = await currentBackendPid(base);
    const waiter = actor(await open());
    const waiterPid = await currentBackendPid(waiter.client);
    const write = writer.run(seed, (p) =>
      writer.inTransaction(async () => {
        await p.upsertVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
          { priceCents: 0, tierPrices: [{ minQuantity: 0, priceCents: 0 }] },
        );
        await p.upsertVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
          { priceCents: 900 },
        );
      }),
    );
    const outcome = write.then(
      () => null,
      (error: unknown) => error,
    );
    let waiting: ReturnType<ProductsService['updatePriceList']> | undefined;
    try {
      await held.reached;
      waiting = waiter.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      );
      expect(await waitForLockWait(observer, waiterPid)).toContain(writerPid);
    } finally {
      held.release(new Error('late single-upsert failure'));
      await Promise.allSettled([outcome, waiting]);
    }
    await expect(outcome).resolves.toEqual(
      new Error('late single-upsert failure'),
    );
    await expect(waiting).resolves.toMatchObject({ id: seed.ids.priceListId });
    await expect(
      observer.variantPrice.findFirst({ where, include: { tierPrices: true } }),
    ).resolves.toEqual(before);
    await expect(
      waiter.run(seed, (p) =>
        p.upsertVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
          { priceCents: 500 },
        ),
      ),
    ).resolves.toMatchObject({ priceCents: 500 });
  });

  it.each(['Variant', 'PriceList'])(
    'single upsert observes cooperating %s disappearance after waiting',
    async (entity) => {
      const seed = await freshSeed();
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) => model === entity && operation === 'delete',
      );
      const holderPid = await currentBackendPid(base);
      const updater = actor(await open());
      const updaterPid = await currentBackendPid(updater.client);
      const holding = held.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
        if (entity === 'Variant')
          await tx.variant.delete({ where: { id: seed.ids.variantId } });
        else await tx.priceList.delete({ where: { id: seed.ids.priceListId } });
      });
      let outcome: Promise<unknown> | undefined;
      try {
        await held.reached;
        outcome = updater
          .run(seed, (p) =>
            p.upsertVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
              { priceCents: 0 },
            ),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(await waitForLockWait(observer, updaterPid)).toContain(
          holderPid,
        );
      } finally {
        held.release();
        await Promise.allSettled([holding, outcome]);
      }
      await expect(holding).resolves.toBeUndefined();
      await expect(outcome).resolves.toMatchObject({
        code: 'ENTITY_NOT_FOUND',
        message: `${entity} with id "${entity === 'Variant' ? seed.ids.variantId : seed.ids.priceListId}" not found`,
      });
      await expect(
        readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
      ).resolves.toEqual([]);
    },
  );

  it('waits before price-list observation and computes margins from fresh cost', async () => {
    const seed = await freshSeed();
    const other = await freshSeed();
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) =>
        model === 'PriceList' && operation === 'update',
    );
    const holderPid = await currentBackendPid(base);
    const updater = actor(await open());
    const updaterPid = await currentBackendPid(updater.client);
    const unrelated = actor(await open());
    const holding = held.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
      await tx.product.update({
        where: { id: seed.ids.productId },
        data: { purchaseNetCostCents: 500 },
      });
      await tx.priceList.update({
        where: { id: seed.ids.priceListId },
        data: { priceCents: 1500 },
      });
    });
    let update: ReturnType<ProductsService['updatePriceList']> | undefined;
    try {
      await held.reached;
      update = updater.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      );
      expect(await waitForLockWait(observer, updaterPid)).toContain(holderPid);
      await expect(
        unrelated.run(other, (p) =>
          p.updatePriceList(other.ids.productId, other.ids.priceListId, {
            priceCents: 0,
          }),
        ),
      ).resolves.toMatchObject({ priceCents: 0 });
    } finally {
      held.release();
      await Promise.allSettled([holding, update]);
    }
    await expect(holding).resolves.toBeUndefined();
    await expect(update).resolves.toMatchObject({
      priceCents: 1500,
      margin: { amountCents: 1000, percent: 67 },
    });
  });

  it('rolls back price and tier replacement in an ambient transaction and releases the gate', async () => {
    const seed = await freshSeed();
    const base = await open();
    let gates = 0;
    const held = latch(
      base,
      (sql) =>
        sql.includes('FROM "products"') &&
        sql.includes('FOR UPDATE') &&
        ++gates === 2,
    );
    const writer = actor(held.client);
    const writerPid = await currentBackendPid(base);
    const waiter = actor(await open());
    const waiterPid = await currentBackendPid(waiter.client);
    const where = { id: seed.ids.priceListId, tenantId: seed.ids.tenantId };
    const before = await observer.priceList.findFirstOrThrow({
      where,
      include: { tierPrices: true },
    });
    const write = writer.run(seed, (p) =>
      writer.inTransaction(async () => {
        await p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {
          priceCents: 0,
          tierPrices: [{ minQuantity: 0, priceCents: 0 }],
        });
        await p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {
          priceCents: 900,
        });
      }),
    );
    const outcome = write.then(
      () => null,
      (error: unknown) => error,
    );
    let update: ReturnType<ProductsService['updatePriceList']> | undefined;
    try {
      await held.reached;
      update = waiter.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      );
      expect(await waitForLockWait(observer, waiterPid)).toContain(writerPid);
    } finally {
      held.release(new Error('late price failure'));
      await Promise.allSettled([outcome, update]);
    }
    await expect(outcome).resolves.toEqual(new Error('late price failure'));
    await expect(update).resolves.toMatchObject({
      priceCents: before.priceCents,
      tierPrices: before.tierPrices,
    });
    const after = await observer.priceList.findFirstOrThrow({
      where,
      include: { tierPrices: true },
    });
    expect(after).toEqual({ ...before, updatedAt: after.updatedAt });
  });

  it('observes a cooperating price-list deletion after waiting on the Product gate', async () => {
    const seed = await freshSeed();
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) =>
        model === 'PriceList' && operation === 'delete',
    );
    const holderPid = await currentBackendPid(base);
    const updater = actor(await open());
    const updaterPid = await currentBackendPid(updater.client);
    // Explicit cooperating deletion, not a claim about global-list lifecycle writers.
    const deletion = held.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
      await tx.priceList.delete({ where: { id: seed.ids.priceListId } });
    });
    let outcome: Promise<unknown> | undefined;
    try {
      await held.reached;
      outcome = updater
        .run(seed, (p) =>
          p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {
            priceCents: 0,
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(await waitForLockWait(observer, updaterPid)).toContain(holderPid);
    } finally {
      held.release();
      await Promise.allSettled([deletion, outcome]);
    }
    await expect(deletion).resolves.toBeUndefined();
    await expect(outcome).resolves.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
      message: `PriceList with id "${seed.ids.priceListId}" not found`,
    });
    await expect(
      observer.priceList.findFirst({ where: { id: seed.ids.priceListId } }),
    ).resolves.toBeNull();
  });

  it.each([false, true])(
    'waits before price deletion and retains default protection=%s',
    async (isDefault) => {
      const seed = await freshSeed();
      const other = await freshSeed();
      await observer.globalPriceList.update({
        where: { id: seed.ids.globalPriceListId },
        data: { isDefault },
      });
      const base = await open();
      const held = latch(
        base,
        (_sql, model, operation) =>
          model === 'VariantPrice' && operation === 'delete',
      );
      const holderPid = await currentBackendPid(base);
      const remover = actor(await open());
      const removerPid = await currentBackendPid(remover.client);
      const unrelated = actor(await open());
      const holding = held.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
        await tx.variantPrice.delete({
          where: { id: seed.ids.variantPriceId },
        });
      });
      let outcome: Promise<unknown> | undefined;
      try {
        await held.reached;
        outcome = remover
          .run(seed, (p) =>
            p.removeVariantPrice(
              seed.ids.productId,
              seed.ids.variantId,
              seed.ids.priceListId,
            ),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(await waitForLockWait(observer, removerPid)).toContain(
          holderPid,
        );
        await expect(
          unrelated.run(other, (p) =>
            p.removeVariantPrice(
              other.ids.productId,
              other.ids.variantId,
              other.ids.priceListId,
            ),
          ),
        ).resolves.toBeUndefined();
        await expect(
          readVariantPrices(observer, other.ids.tenantId, other.ids.variantId),
        ).resolves.toEqual([]);
      } finally {
        held.release();
        await Promise.allSettled([holding, outcome]);
      }
      await expect(holding).resolves.toBeUndefined();
      await expect(outcome).resolves.toMatchObject(
        isDefault
          ? {
              code: 'DEFAULT_PRICE_LIST_PROTECTED',
              message: 'Cannot delete the default PUBLICO price list',
            }
          : {
              code: 'ENTITY_NOT_FOUND',
              message: `VariantPrice with id "${seed.ids.variantId}:${seed.ids.priceListId}" not found`,
            },
      );
      await expect(
        readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
      ).resolves.toEqual([]);
    },
  );

  it('restores a deleted price and tiers after ambient rollback and releases the gate', async () => {
    const seed = await freshSeed();
    const where = { id: seed.ids.variantPriceId, tenantId: seed.ids.tenantId };
    const before = await observer.variantPrice.update({
      where,
      data: {
        tierPrices: {
          create: {
            tenantId: seed.ids.tenantId,
            minQuantity: 2,
            priceCents: 900,
          },
        },
      },
      include: { tierPrices: true },
    });
    const base = await open();
    let gates = 0;
    const held = latch(
      base,
      (sql) =>
        sql.includes('FROM "products"') &&
        sql.includes('FOR UPDATE') &&
        ++gates === 2,
    );
    const writer = actor(held.client);
    const writerPid = await currentBackendPid(base);
    const waiter = actor(await open());
    const waiterPid = await currentBackendPid(waiter.client);
    const write = writer.run(seed, (p) =>
      writer.inTransaction(async () => {
        await p.removeVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
        );
        await p.removeVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
        );
      }),
    );
    const outcome = write.then(
      () => null,
      (error: unknown) => error,
    );
    let update: ReturnType<ProductsService['updatePriceList']> | undefined;
    try {
      await held.reached;
      update = waiter.run(seed, (p) =>
        p.updatePriceList(seed.ids.productId, seed.ids.priceListId, {}),
      );
      expect(await waitForLockWait(observer, waiterPid)).toContain(writerPid);
    } finally {
      held.release(new Error('late deletion failure'));
      await Promise.allSettled([outcome, update]);
    }
    await expect(outcome).resolves.toEqual(new Error('late deletion failure'));
    await expect(update).resolves.toMatchObject({ id: seed.ids.priceListId });
    await expect(
      observer.variantPrice.findFirst({ where, include: { tierPrices: true } }),
    ).resolves.toEqual(before);
    await expect(
      waiter.run(seed, (p) =>
        p.removeVariantPrice(
          seed.ids.productId,
          seed.ids.variantId,
          seed.ids.priceListId,
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      observer.variantTierPrice.findMany({
        where: { variantPriceId: seed.ids.variantPriceId },
      }),
    ).resolves.toEqual([]);
  });

  it('waits before updateVariant observation while another Product proceeds', async () => {
    const seed = await freshSeed();
    const other = await freshSeed();
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) => model === 'Variant' && operation === 'update',
    );
    const holderPid = await currentBackendPid(base);
    const updater = actor(await open());
    const updaterPid = await currentBackendPid(updater.client);
    const unrelated = actor(await open());
    // Explicit parent gate: this scenario does not use or certify a V2 publisher.
    const holding = held.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId}
        AND "id" = ${seed.ids.productId} FOR UPDATE`;
      await tx.variant.update({
        where: {
          id: seed.ids.variantId,
          tenantId: seed.ids.tenantId,
          productId: seed.ids.productId,
        },
        data: {
          onlineStockPresentation: 'CUSTOM_QUANTITY',
          onlineStockPresentationCustomQty: 7,
        },
      });
    });
    let update: ReturnType<ProductsService['updateVariant']> | undefined;
    try {
      await held.reached;
      update = updater.run(seed, (p) =>
        p.updateVariant(seed.ids.productId, seed.ids.variantId, {
          onlineStockPresentationCustomQty: 9,
        }),
      );
      // A pre-gate read would see null presentation and reject instead of waiting.
      expect(await waitForLockWait(observer, updaterPid)).toContain(holderPid);
      await expect(
        unrelated.run(other, (p) =>
          p.updateVariant(other.ids.productId, other.ids.variantId, {
            name: 'Unrelated',
          }),
        ),
      ).resolves.toMatchObject({ name: 'Unrelated' });
    } finally {
      held.release();
      await Promise.allSettled([holding, update]);
    }
    await expect(holding).resolves.toBeUndefined();
    await expect(update).resolves.toMatchObject({
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 9,
    });
    await expect(
      observer.variant.findFirst({
        where: { id: seed.ids.variantId, tenantId: seed.ids.tenantId },
      }),
    ).resolves.toMatchObject({
      onlineStockPresentation: 'CUSTOM_QUANTITY',
      onlineStockPresentationCustomQty: 9,
    });
  });

  it('rolls back an executed update in an ambient transaction and releases its gate', async () => {
    const seed = await freshSeed();
    const base = await open();
    let gates = 0;
    const held = latch(
      base,
      (sql) =>
        sql.includes('FROM "products"') &&
        sql.includes('FOR UPDATE') &&
        ++gates === 2,
    );
    const writer = actor(held.client);
    const writerPid = await currentBackendPid(base);
    const waiter = actor(await open());
    const waiterPid = await currentBackendPid(waiter.client);
    const before = await observer.variant.findFirstOrThrow({
      where: { id: seed.ids.variantId, tenantId: seed.ids.tenantId },
    });
    const write = writer.run(seed, (p) =>
      writer.inTransaction(async () => {
        await p.updateVariant(seed.ids.productId, seed.ids.variantId, {
          catalogPublishMode: 'OFF',
          name: 'Rolled back',
        });
        await p.updateVariant(seed.ids.productId, seed.ids.variantId, {
          name: 'Never committed',
        });
      }),
    );
    // Attach rejection handling immediately; the injected late failure is expected.
    const outcome = write.then(
      () => null,
      (error: unknown) => error,
    );
    let update: ReturnType<ProductsService['updateVariant']> | undefined;
    try {
      await held.reached;
      update = waiter.run(seed, (p) =>
        p.updateVariant(seed.ids.productId, seed.ids.variantId, {
          name: 'After rollback',
        }),
      );
      expect(await waitForLockWait(observer, waiterPid)).toContain(writerPid);
    } finally {
      held.release(new Error('late update failure'));
      await Promise.allSettled([outcome, update]);
    }
    await expect(outcome).resolves.toEqual(new Error('late update failure'));
    await expect(update).resolves.toMatchObject({
      name: 'After rollback',
      catalogPublishMode: before.catalogPublishMode,
    });
    const after = await observer.variant.findFirstOrThrow({
      where: { id: seed.ids.variantId, tenantId: seed.ids.tenantId },
    });
    expect(after).toEqual({
      ...before,
      name: 'After rollback',
      updatedAt: after.updatedAt,
    });
  });

  it('serializes updateVariant before removeVariant without retaining a stale child', async () => {
    const seed = await freshSeed();
    const base = await open();
    const held = latch(
      base,
      (_sql, model, operation) => model === 'Variant' && operation === 'update',
    );
    const updater = actor(held.client);
    const updaterPid = await currentBackendPid(base);
    const remover = actor(await open());
    const removerPid = await currentBackendPid(remover.client);
    const update = updater.run(seed, (p) =>
      p.updateVariant(seed.ids.productId, seed.ids.variantId, {
        catalogPublishMode: 'OFF',
      }),
    );
    let removal: Promise<void> | undefined;
    try {
      await held.reached;
      removal = remover.run(seed, (p) =>
        p.removeVariant(seed.ids.productId, seed.ids.variantId),
      );
      expect(await waitForLockWait(observer, removerPid)).toContain(updaterPid);
    } finally {
      held.release();
      await Promise.allSettled([update, removal]);
    }
    await expect(update).resolves.toMatchObject({ catalogPublishMode: 'OFF' });
    await expect(removal).resolves.toBeUndefined();
    const membership = await readVariantMembership(
      observer,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    expect(membership.variants).toEqual([]);
    expect(membership.products[0]).toMatchObject({ hasVariants: false });
    await expect(
      readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
    ).resolves.toEqual([]);
  });

  it('serializes a mixed stock charge before removal without a deadlock', async () => {
    const seed = await freshSeed();
    // Parent stock for the Product branch; thresholds avoid low-stock crossings/outbox.
    await observer.$executeRaw`UPDATE "products" SET "quantity" = ${10}, "minQuantity" = ${0}
      WHERE "tenantId" = ${seed.ids.tenantId} AND "id" = ${seed.ids.productId}`;
    const batchBase = await open();
    // Pause before the first stock UPDATE: fixed code already holds its parent gate.
    const paused = latch(batchBase, (sql) => sql.includes('UPDATE "products"'));
    const batch = actor(paused.client);
    const remover = actor(await open());
    const batchPid = await currentBackendPid(batchBase);
    const removerPid = await currentBackendPid(remover.client);

    const charge = batch.run(seed, (p) =>
      // decrementStockForCharge requires an ambient transaction (repository guard).
      batch.inTransaction(() =>
        p.decrementStockForCharge([
          {
            productId: seed.ids.productId,
            variantId: seed.ids.variantId,
            quantity: 1,
          },
          { productId: seed.ids.productId, quantity: 1 },
        ]),
      ),
    );
    let removal: Promise<void> | undefined;
    try {
      await paused.reached;
      removal = remover.run(seed, (p) =>
        p.removeVariant(seed.ids.productId, seed.ids.variantId),
      );
      // Removal must wait on the charge's parent gate, before reading/deleting the child.
      expect(await waitForLockWait(observer, removerPid)).toContain(batchPid);
    } finally {
      paused.release();
      await Promise.allSettled([charge, removal]);
    }
    const [charged, removed] = await Promise.allSettled([charge, removal]);
    process.stdout.write(
      `mixed charge/removal pids=${batchPid},${removerPid} SQLSTATEs=${JSON.stringify(
        [charged, removed].map((o) =>
          o.status === 'rejected' ? postgresSqlState(o.reason) : null,
        ),
      )}\n`,
    );
    expect(charged.status).toBe('fulfilled');
    expect(removed.status).toBe('fulfilled');

    const membership = await readVariantMembership(
      observer,
      seed.ids.tenantId,
      seed.ids.productId,
    );
    expect(membership.variants).toEqual([]);
    expect(membership.products[0]).toMatchObject({
      hasVariants: false,
      quantity: 9,
    });
    await expect(
      readVariantPrices(observer, seed.ids.tenantId, seed.ids.variantId),
    ).resolves.toEqual([]);
  });
});
