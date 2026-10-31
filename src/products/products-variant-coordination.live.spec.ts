import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';
import type { CatalogEditorialCore } from '../catalog-editorial/application/catalog-editorial-core';
import type { EditorialDocument } from '../catalog-editorial/domain/document';
import type { ProductsService } from './products.service';
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
    work: (products: ProductsService) => Promise<T>,
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
      const products = new ProductsService(
        repository,
        unused('ProductsService root PrismaService'),
        unused('FilesService'),
        tenant,
        unused('SatCatalogService'),
      );
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
            () => work(products),
          ),
      };
    };
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((client) => client.$disconnect()));
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
