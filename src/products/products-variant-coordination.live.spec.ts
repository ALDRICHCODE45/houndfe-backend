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
