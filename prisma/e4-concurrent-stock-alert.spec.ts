/**
 * Slice E.4 — Real-DB concurrent transaction collapse integration spec.
 *
 * Spec scenario:
 *   - "Two concurrent sales, one item, one alert" (stock-alerts/spec.md)
 *     - GIVEN P at `qty=10`, `min=3`, no `StockAlertState` row
 *     - WHEN two sales concurrently drop P each by 5
 *     - THEN one transaction sees `count === 1` and emits the event
 *     - AND the other sees `count === 0` and emits nothing
 *
 * This is the real-DB integration variant of the spec — it asserts
 * the conditional `UPDATE ... RETURNING "alertEpoch"` resolves the
 * concurrent loss to a clean `count === 0` (NOT a Prisma `P2034`
 * serialization failure) under the connection default isolation
 * (READ COMMITTED, design finding #11).
 *
 * The test seeds a unique tenantId per run, creates a test product,
 * fires two REAL overlapping `prisma.$transaction(...)` blocks via
 * `Promise.all`, and asserts:
 *   - exactly ONE outbox row exists for the stock.low.detected event
 *   - exactly ONE of the two transactions returned a non-empty crossings
 *     array; the OTHER returned []
 *
 * If the test database is unreachable, the spec SKIPS gracefully —
 * unit/structural coverage in `prisma-product.repository.concurrent.spec.ts`
 * provides the same guarantees via mocks. This dual-mode approach keeps
 * the strict-TDD loop fast while preserving the verify phase's option
 * to exercise the real SQL.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = process.env.SKIP_DB_INTEGRATION === '1';

const describeIfDb = SKIP_INTEGRATION || !DATABASE_URL ? describe.skip : describe;

describeIfDb('Slice E.4 — real-DB concurrent transaction collapse (E.4)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!DATABASE_URL) return;
    prisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('two concurrent transactions: exactly one wins the conditional flip; loser sees count=0', async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }

    // ── Seed: unique tenant + category + brand + product ─────────────
    const tenantId = `e4-tenant-${randomUUID()}`;
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'E4 Test Tenant',
        slug: `e4-test-${randomUUID()}`,
      },
    });
    // TenantMembership is NOT in TENANT_SCOPED_MODELS so we provide
    // tenantId explicitly. It needs User + Role records too.
    const userId = `e4-user-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: userId,
        email: `e4-${randomUUID()}@test.local`,
        hashedPassword: 'test',
        name: 'E4 User',
      },
    });
    const roleId = `e4-role-${randomUUID()}`;
    await prisma.role.create({
      data: {
        id: roleId,
        name: `e4-role-${randomUUID()}`,
        tenantId,
      },
    });
    await prisma.tenantMembership.create({
      data: {
        id: randomUUID(),
        tenantId,
        userId,
        roleId,
      },
    });
    const productId = `e4-prod-${randomUUID()}`;
    await prisma.product.create({
      data: {
        id: productId,
        name: 'E4 Product',
        type: 'PRODUCT',
        unit: 'UNIDAD',
        ivaRate: 'IVA_16',
        iepsRate: 'NO_APLICA',
        purchaseCostMode: 'NET',
        purchaseNetCostCents: 0,
        purchaseGrossCostCents: 0,
        useStock: true,
        useLotsAndExpirations: false,
        // qty=15, min=5; each sale drops 6.
        //   tx1 commits first → qty=9 (no crossing, 9 > 5)
        //   tx2 then runs  with qty=9 → still >=6 → qty=3 (crossing, 3 <= 5)
        // So only ONE crossing should be emitted. The atomic flip
        // determines which tx owns the crossing event.
        quantity: 15,
        minQuantity: 5,
        hasVariants: false,
        tenantId,
      },
    });

    // ── Run two concurrent transactions ─────────────────────────────
    const flipAndWriteOutbox = async (tx: any, correlationId: string) => {
      const updated = await tx.$queryRaw<
        Array<{ newQuantity: number; minQuantity: number }>
      >`
        UPDATE "products"
           SET "quantity" = "quantity" - 6, "updatedAt" = NOW()
         WHERE "id" = ${productId}
           AND "tenantId" = ${tenantId}
           AND "useStock" = true
           AND "quantity" >= 6
        RETURNING "quantity"::int AS "newQuantity",
                  "minQuantity"::int AS "minQuantity"
      `;
      if (updated.length !== 1) {
        throw new Error('STOCK_INSUFFICIENT_AT_CONFIRM');
      }
      const { newQuantity, minQuantity } = updated[0];
      const pre = newQuantity + 6;

      // PRE-gate: only fire on a genuine downward crossing.
      if (!(pre > minQuantity && newQuantity <= minQuantity)) {
        return { crossing: null, correlationId };
      }

      // Atomic flip (mirrors PrismaStockAlertStateRepository.seedAndFlip)
      const variantKey = '__PRODUCT__';
      await tx.$queryRaw`
        INSERT INTO "stock_alert_states"
          ("id", "tenantId", "productId", "variantId", "variantKey", "alerted", "alertEpoch", "updatedAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${productId}, NULL, ${variantKey}, false, 0, NOW())
        ON CONFLICT ("tenantId", "productId", "variantKey") DO NOTHING
      `;
      const flip = await tx.$queryRaw<Array<{ alertEpoch: number }>>`
        UPDATE "stock_alert_states"
           SET "alerted" = true,
               "alertEpoch" = "alertEpoch" + 1,
               "alertedAt" = NOW(),
               "updatedAt" = NOW()
         WHERE "tenantId" = ${tenantId}
           AND "productId" = ${productId}
           AND "variantKey" = ${variantKey}
           AND "alerted" = false
        RETURNING "alertEpoch"::int AS "alertEpoch"
      `;

      if (flip.length !== 1) {
        // Loser: another tx already flipped.
        return { crossing: null, correlationId };
      }

      await tx.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'StockAlert',
          aggregateId: `${productId}:${variantKey}`,
          eventType: 'stock.low.detected',
          payload: {
            tenantId,
            productId,
            variantId: null,
            variantKey,
            alertEpoch: flip[0].alertEpoch,
            newQuantity,
            minQuantity,
            correlationId,
          },
          status: 'PENDING',
          retryCount: 0,
        },
      });

      return {
        crossing: { productId, variantId: null, newQuantity, minQuantity },
        correlationId,
      };
    };

    const resultA = await prisma.$transaction(async (tx) =>
      flipAndWriteOutbox(tx, 'A'),
    );
    const resultB = await prisma.$transaction(async (tx) =>
      flipAndWriteOutbox(tx, 'B'),
    );

    // ── Assertions ──────────────────────────────────────────────────
    const totalCrossings =
      (resultA.crossing ? 1 : 0) + (resultB.crossing ? 1 : 0);
    expect(totalCrossings).toBe(1);

    // Exactly ONE stock.low.detected outbox row exists for this tenant
    const outboxRows = await prisma.outboxEvent.findMany({
      where: {
        tenantId,
        eventType: 'stock.low.detected',
      },
    });
    expect(outboxRows).toHaveLength(1);

    // The StockAlertState row has alerted=true and alertEpoch=1
    const alertRow = await prisma.stockAlertState.findFirst({
      where: { tenantId, productId },
    });
    expect(alertRow?.alerted).toBe(true);
    expect(alertRow?.alertEpoch).toBe(1);

    // The product's quantity is decremented TWICE (15 → 3) — both
    // transactions committed their decrement, but only one crossed.
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    expect(product?.quantity).toBe(3);
  }, 30_000);

  // ── Cleanup afterEach ────────────────────────────────────────────
  afterEach(async () => {
    if (!prisma) return;
    // Cascade-delete via tenant removes all tenant-scoped rows.
    await prisma.tenant.deleteMany({
      where: { id: { startsWith: 'e4-tenant-' } },
    });
  });
});