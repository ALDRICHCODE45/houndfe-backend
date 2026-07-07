/**
 * Slice E.1 — PrismaStockAlertStateRepository REAL-DB integration spec.
 *
 * Bug proof: the `INSERT ... ON CONFLICT DO NOTHING` in `seedAndFlip` MUST
 * provide a value for `"updatedAt"` because the column is `NOT NULL` with NO
 * database default. On the FIRST crossing for any (tenantId, productId,
 * variantKey) the row does not exist, the INSERT actually executes, and the
 * missing NOT NULL column aborts the whole sale transaction.
 *
 * This spec drives the REAL `PrismaStockAlertStateRepository.seedAndFlip`
 * (NOT inline SQL) inside a real `prisma.$transaction` against the dev
 * Postgres — exactly mirroring the production path through
 * `PrismaProductRepository.decrementStockForCharge → flipAndOutbox →
 * seedAndFlip`. The structural mock spec
 * (`prisma-stock-alert-state.repository.spec.ts`) only asserts SQL shape;
 * it cannot detect a NOT NULL violation.
 *
 * RED: before the seed INSERT adds `"updatedAt" = NOW()`, this test throws
 * `null value in column "updatedAt" of relation "stock_alert_states"
 * violates not-null constraint` from the very first call.
 *
 * GREEN: after the fix, both calls return the expected epoch (1 then null)
 * and the durable row carries the supplied `updatedAt`.
 *
 * If the test database is unreachable, the spec SKIPS gracefully — the
 * structural mock spec covers the SQL-shape contract.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaStockAlertStateRepository } from '../src/stock-alerts/infrastructure/prisma-stock-alert-state.repository';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = process.env.SKIP_DB_INTEGRATION === '1';

const describeIfDb = SKIP_INTEGRATION || !DATABASE_URL ? describe.skip : describe;

describeIfDb('PrismaStockAlertStateRepository — real-DB seedAndFlip (E.1)', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let productId: string;

  beforeAll(() => {
    if (!DATABASE_URL) return;
    prisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
  });

  beforeEach(async () => {
    if (!prisma) return;
    tenantId = `e1realdb-tenant-${randomUUID()}`;
    const userId = `e1realdb-user-${randomUUID()}`;
    const roleId = `e1realdb-role-${randomUUID()}`;
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'E1 Real-DB Tenant',
        slug: `e1realdb-${randomUUID()}`,
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        email: `e1realdb-${randomUUID()}@test.local`,
        hashedPassword: 'test',
        name: 'E1 Real-DB User',
      },
    });
    await prisma.role.create({
      data: { id: roleId, name: `e1realdb-role-${randomUUID()}`, tenantId },
    });
    await prisma.tenantMembership.create({
      data: { id: randomUUID(), tenantId, userId, roleId },
    });
    productId = `e1realdb-prod-${randomUUID()}`;
    await prisma.product.create({
      data: {
        id: productId,
        name: 'E1 Real-DB Product',
        type: 'PRODUCT',
        unit: 'UNIDAD',
        ivaRate: 'IVA_16',
        iepsRate: 'NO_APLICA',
        purchaseCostMode: 'NET',
        purchaseNetCostCents: 0,
        purchaseGrossCostCents: 0,
        useStock: true,
        useLotsAndExpirations: false,
        quantity: 10,
        minQuantity: 3,
        hasVariants: false,
        tenantId,
      },
    });
  });

  afterEach(async () => {
    if (!prisma) return;
    await prisma.tenant.deleteMany({
      where: { id: { startsWith: 'e1realdb-tenant-' } },
    });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('seedAndFlip on a brand-new key succeeds and returns epoch=1 (proves updatedAt is supplied)', async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }

    const repo = new PrismaStockAlertStateRepository();

    // Mirrors what `decrementStockForCharge → flipAndOutbox` does inside
    // its tx: open the tx, hand the tx client to seedAndFlip, expect the
    // alertEpoch (or null on the loser side).
    const result = await prisma.$transaction(async (tx) => {
      return repo.seedAndFlip({
        tx,
        tenantId,
        productId,
        variantId: null,
      });
    });

    expect(result).toBe(1);

    // And the row is durable with both createdAt and updatedAt populated
    // (updatedAt must NOT be null — that was the bug).
    const row = await prisma.stockAlertState.findFirst({
      where: { tenantId, productId },
    });
    expect(row).not.toBeNull();
    expect(row?.alerted).toBe(true);
    expect(row?.alertEpoch).toBe(1);
    expect(row?.updatedAt).not.toBeNull();
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('a second seedAndFlip on the same key (already alerted) returns null and does NOT throw', async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }

    const repo = new PrismaStockAlertStateRepository();

    const first = await prisma.$transaction(async (tx) =>
      repo.seedAndFlip({ tx, tenantId, productId, variantId: null }),
    );
    expect(first).toBe(1);

    // Second call sees alerted=true → conditional UPDATE matches zero rows.
    const second = await prisma.$transaction(async (tx) =>
      repo.seedAndFlip({ tx, tenantId, productId, variantId: null }),
    );
    expect(second).toBeNull();
  });

  it('rearm on a key that was flipped returns 1 and resets alerted=false', async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }

    const repo = new PrismaStockAlertStateRepository();

    await prisma.$transaction(async (tx) =>
      repo.seedAndFlip({ tx, tenantId, productId, variantId: null }),
    );

    const rearmCount = await prisma.$transaction(async (tx) =>
      repo.rearm({ tx, tenantId, productId, variantId: null }),
    );

    expect(rearmCount).toBe(1);
    const row = await prisma.stockAlertState.findFirst({
      where: { tenantId, productId },
    });
    expect(row?.alerted).toBe(false);
    // alertEpoch is preserved across re-arm — the row sticks around so a
    // future sale can flip it again from a known history point.
    expect(row?.alertEpoch).toBe(1);
  });
});
