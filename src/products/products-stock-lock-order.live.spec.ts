import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import type { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { loadEditorialPostgresClient } from '../catalog-editorial/infrastructure/editorial-coordination-postgres-binding';
import {
  currentBackendPid,
  seedEditorialPostgres,
  waitForLockWait,
  type EditorialFixture,
} from '../catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

// Pause AFTER the first stock UPDATE: both old and fixed code hold a real row lock.
function holdFirstUpdate(base: PrismaClient) {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  const client = base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const result: unknown = await query(args);
        const sql = args as { strings?: string[] };
        if (
          armed &&
          /UPDATE "(?:products|variants)"/.test(sql.strings?.join('?') ?? '')
        ) {
          armed = false;
          reach();
          await gate;
        }
        return result;
      },
    },
  });
  return { client: client as unknown as PrismaClient, reached, release };
}
function postgresSqlState(error: unknown): string | undefined {
  const e = error as { meta?: { code?: unknown }; message?: unknown };
  if (typeof e?.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.meta.code))
    return e.meta.code;
  return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(String(e?.message))?.[1];
}

describe('live charge/restock stock lock ordering', () => {
  const opened: PrismaClient[] = [];
  let observer: PrismaClient;
  let charge: (
    client: PrismaClient,
    seed: EditorialFixture,
    items: Parameters<PrismaProductRepository['decrementStockForCharge']>[0],
  ) => Promise<unknown>;
  let restock: typeof charge;
  const open = async () => {
    const client = await loadEditorialPostgresClient();
    opened.push(client);
    return client;
  };
  beforeAll(async () => {
    observer = await open(); // Guarded client BEFORE application imports.
    const { PrismaProductRepository } =
      await import('./infrastructure/prisma-product.repository');
    const { TenantPrismaService } =
      await import('../shared/prisma/tenant-prisma.service');
    const { PrismaStockAlertStateRepository } =
      await import('../stock-alerts/infrastructure/prisma-stock-alert-state.repository');
    const { ClsService } = await import('nestjs-cls');
    const cls = new ClsService<TenantClsStore>(
      new AsyncLocalStorage<TenantClsStore>(),
    );
    const runner =
      (restocking: boolean): typeof charge =>
      (client, seed, items) => {
        const tenant = new TenantPrismaService(
          client as ConstructorParameters<typeof TenantPrismaService>[0],
          cls,
        );
        // Thresholds stay at zero: no charge crossing/outbox; restock uses real rearm.
        const unused = new Proxy(
          {},
          {
            get() {
              throw new Error('Unexpected alert collaborator');
            },
          },
        );
        const repo = new PrismaProductRepository(
          tenant,
          unused as never,
          new PrismaStockAlertStateRepository(),
        );
        return cls.runWith(
          {
            tenantId: seed.ids.tenantId,
            userId: seed.ids.userId,
            isSuperAdmin: false,
          },
          () =>
            tenant.runInTransaction<unknown>(() =>
              restocking
                ? repo.incrementStockForRestock(items)
                : repo.decrementStockForCharge(items),
            ),
        );
      };
    charge = runner(false);
    restock = runner(true);
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((client) => client.$disconnect()));
  });

  // Each case uses the identical scheduler witness and exact readback contract.
  async function oppositeProducts(kind: 'charge' | 'restock') {
    const run = kind === 'charge' ? charge : restock;
    const seed = await seedEditorialPostgres(observer, randomUUID());
    const otherId = randomUUID();
    await observer.$executeRaw`UPDATE "products" SET "quantity" = ${10} WHERE "tenantId" = ${seed.ids.tenantId} AND "id" = ${seed.ids.productId}`;
    await observer.$executeRaw`INSERT INTO "products" ("id", "tenantId", "name", "sku", "quantity", "updatedAt") VALUES (${otherId}, ${seed.ids.tenantId}, ${otherId}, ${otherId}, ${10}, NOW())`;
    const firstBase = await open();
    const held = holdFirstUpdate(firstBase);
    const secondClient = await open();
    const firstPid = await currentBackendPid(firstBase);
    const secondPid = await currentBackendPid(secondClient);
    const items = [seed.ids.productId, otherId]
      .sort()
      .map((productId) => ({ productId, quantity: 1 }));
    const first = run(held.client, seed, items);
    let second: Promise<unknown> | undefined;
    try {
      await held.reached;
      second = run(secondClient, seed, [...items].reverse());
      expect(await waitForLockWait(observer, secondPid)).toContain(firstPid);
    } finally {
      held.release();
      await Promise.allSettled([first, second]);
    }
    const outcomes = await Promise.allSettled([first, second]);
    const states = outcomes.map((o) =>
      o.status === 'rejected' ? postgresSqlState(o.reason) : null,
    );
    process.stdout.write(
      `opposite ${kind} pids=${firstPid},${secondPid} SQLSTATEs=${JSON.stringify(states)}\n`,
    );
    expect(states).toEqual([null, null]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await observer.$queryRaw<
      { id: string; quantity: number }[]
    >`SELECT "id", "quantity" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId} ORDER BY "id"`;
    expect(rows).toEqual(
      items.map(({ productId }) => ({
        id: productId,
        quantity: kind === 'charge' ? 8 : 12,
      })),
    );
  }
  it.each(['charge', 'restock'] as const)(
    'commits opposite-order Product %s batches without a deadlock',
    oppositeProducts,
  );

  it('serializes a Variant-first mixed restock before a parent-first mixed charge', async () => {
    const seed = await seedEditorialPostgres(observer, randomUUID());
    await observer.$executeRaw`UPDATE "products" SET "quantity" = ${10} WHERE "tenantId" = ${seed.ids.tenantId} AND "id" = ${seed.ids.productId}`;
    const restockBase = await open();
    const held = holdFirstUpdate(restockBase);
    const chargeClient = await open();
    const restockPid = await currentBackendPid(restockBase);
    const chargePid = await currentBackendPid(chargeClient);
    const parent = { productId: seed.ids.productId, quantity: 2 };
    const variant = { ...parent, variantId: seed.ids.variantId };
    // Before the fix, restock holds V while charge takes P and then waits for V.
    // After the fix, restock already holds P before its first stock UPDATE.
    const restocking = restock(held.client, seed, [variant, parent]);
    let charging: Promise<unknown> | undefined;
    try {
      await held.reached;
      charging = charge(chargeClient, seed, [
        { ...parent, quantity: 1 },
        { ...variant, quantity: 1 },
      ]);
      expect(await waitForLockWait(observer, chargePid)).toContain(restockPid);
    } finally {
      held.release();
      await Promise.allSettled([restocking, charging]);
    }
    const outcomes = await Promise.allSettled([restocking, charging]);
    const states = outcomes.map((o) =>
      o.status === 'rejected' ? postgresSqlState(o.reason) : null,
    );
    process.stdout.write(
      `mixed restock/charge pids=${restockPid},${chargePid} SQLSTATEs=${JSON.stringify(states)}\n`,
    );
    expect(states).toEqual([null, null]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const products = await observer.$queryRaw<
      { quantity: number }[]
    >`SELECT "quantity" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId} AND "id" = ${seed.ids.productId}`;
    const variants = await observer.$queryRaw<
      { quantity: number }[]
    >`SELECT "quantity" FROM "variants" WHERE "tenantId" = ${seed.ids.tenantId} AND "id" = ${seed.ids.variantId}`;
    expect(products).toEqual([{ quantity: 11 }]);
    expect(variants).toEqual([{ quantity: 11 }]);
  });

  it('keeps sibling Variant charges concurrent while the first holds its locks', async () => {
    const seed = await seedEditorialPostgres(observer, randomUUID());
    const siblingId = randomUUID();
    await observer.$executeRaw`INSERT INTO "variants" ("id", "tenantId", "productId", "name", "quantity", "updatedAt") VALUES (${siblingId}, ${seed.ids.tenantId}, ${seed.ids.productId}, ${siblingId}, ${10}, NOW())`;
    const firstBase = await open();
    const held = holdFirstUpdate(firstBase);
    const secondClient = await open();
    const firstPid = await currentBackendPid(firstBase);
    const secondPid = await currentBackendPid(secondClient);
    const first = charge(held.client, seed, [
      {
        productId: seed.ids.productId,
        variantId: seed.ids.variantId,
        quantity: 1,
      },
    ]);
    let second: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await held.reached;
      second = charge(secondClient, seed, [
        { productId: seed.ids.productId, variantId: siblingId, quantity: 1 },
      ]);
      // Completion before release proves no blocking dependency on the held actor.
      await Promise.race([
        second,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Sibling charge waited')),
            1500,
          );
        }),
      ]);
      const rows = await observer.$queryRaw<
        { blockers: number[] }[]
      >`SELECT pg_blocking_pids(${secondPid}::int) AS blockers`;
      expect(rows[0].blockers).toEqual([]);
      process.stdout.write(
        `sibling charges pids=${firstPid},${secondPid} completed while first paused; blockers=[]\n`,
      );
    } finally {
      clearTimeout(timer);
      held.release();
      await Promise.allSettled([first, second]);
    }
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    const rows = await observer.$queryRaw<
      { quantity: number }[]
    >`SELECT "quantity" FROM "variants" WHERE "tenantId" = ${seed.ids.tenantId} AND "productId" = ${seed.ids.productId}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.quantity)).toEqual([9, 9]);
  });
});
