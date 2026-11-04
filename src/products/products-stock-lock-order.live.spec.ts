import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import type { StockChargeItem } from '../inventory/domain/stock-journal.types';
import { loadEditorialPostgresClient } from '../catalog-editorial/infrastructure/editorial-coordination-postgres-binding';
import {
  currentBackendPid,
  seedEditorialPostgres,
  waitForLockWait,
  type EditorialFixture,
} from '../catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

// Pause AFTER the first product row lock: the holder owns a real row lock.
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
          /FROM "products"[\s\S]*FOR UPDATE/.test(sql.strings?.join('?') ?? '')
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

describe('live legacy-restore stock lock ordering', () => {
  const opened: PrismaClient[] = [];
  let observer: PrismaClient;
  let restock: (
    client: PrismaClient,
    seed: EditorialFixture,
    lines: StockChargeItem[],
  ) => Promise<unknown>;
  const open = async () => {
    const client = await loadEditorialPostgresClient();
    opened.push(client);
    return client;
  };
  beforeAll(async () => {
    observer = await open(); // Guarded client BEFORE application imports.
    const { StockJournalWriter } =
      await import('../inventory/infrastructure/stock-journal.writer');
    const { TenantPrismaService } =
      await import('../shared/prisma/tenant-prisma.service');
    const { ClsService } = await import('nestjs-cls');
    const cls = new ClsService<TenantClsStore>(
      new AsyncLocalStorage<TenantClsStore>(),
    );
    restock = (client, seed, lines) => {
      const tenant = new TenantPrismaService(
        client as ConstructorParameters<typeof TenantPrismaService>[0],
        cls,
      );
      const writer = new StockJournalWriter(tenant, {
        get: (_key: string, fallback: string) => fallback,
      } as never);
      return cls.runWith(
        {
          tenantId: seed.ids.tenantId,
          userId: seed.ids.userId,
          isSuperAdmin: false,
        },
        () =>
          tenant.runInTransaction<unknown>(() =>
            writer.reverseSale({
              saleId: randomUUID(),
              actor: { id: null, displayName: 'Sistema' },
              confirmedAt: new Date('2020-01-01T00:00:00.000Z'),
              lines,
            }),
          ),
      );
    };
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((client) => client.$disconnect()));
  });

  // Scheduler witness and exact readback contract for the legacy restore path.
  async function oppositeProducts() {
    const run = restock;
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
      `opposite legacy-restore pids=${firstPid},${secondPid} SQLSTATEs=${JSON.stringify(states)}\n`,
    );
    expect(states).toEqual([null, null]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await observer.$queryRaw<
      { id: string; quantity: number }[]
    >`SELECT "id", "quantity" FROM "products" WHERE "tenantId" = ${seed.ids.tenantId} ORDER BY "id"`;
    expect(rows).toEqual(
      items.map(({ productId }) => ({
        id: productId,
        quantity: 12,
      })),
    );
  }
  it(
    'commits opposite-order legacy sale restores without a deadlock',
    oppositeProducts,
  );
});
