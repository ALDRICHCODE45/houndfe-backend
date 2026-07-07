/**
 * Slice E.4 — REAL-DB concurrent transaction collapse integration spec.
 *
 * Spec scenario (stock-alerts/spec.md):
 *   "Two concurrent sales, one item, one alert"
 *   - GIVEN P at `qty=10`, `min=3`, no `StockAlertState` row
 *   - WHEN two sales concurrently drop P each by 5
 *   - THEN one transaction sees `count === 1` and emits the event
 *   - AND the other sees `count === 0` and emits nothing
 *
 * This is the real-DB integration variant of the spec. It exercises the
 * FULL production code path:
 *   PrismaProductRepository.decrementStockForCharge
 *     → flipAndOutbox
 *       → PrismaStockAlertStateRepository.seedAndFlip  (INSERT seed + UPDATE flip)
 *       → OutboxWriterService.publish (INSERT INTO outbox_events)
 *
 * NOT inline SQL — the test wires through the real repositories that the
 * sales orchestrator calls.
 *
 * Concurrency model: both transactions start in `Promise.all`, each wrapped
 * in `TenantPrismaService.runInTransaction` so the CLS tx client is set
 * before `decrementStockForCharge` reads it. Postgres row-locks on the
 * `products` row serialize the two UPDATEs; whichever transaction commits
 * first releases the lock, the second re-reads qty at READ COMMITTED and
 * continues. The conditional `UPDATE stock_alert_states SET alerted=true
 * WHERE alerted=false RETURNING "alertEpoch"` resolves the flip: at most
 * one transaction matches the row, the other sees zero rows.
 *
 * Why the strict-`>` PRE-gate (`pre > minQuantity`) means only one tx
 * reaches the conditional flip from a fresh crossing: after the first
 * crossing tx commits at newQty <= minQuantity, the second tx's fresh
 * `pre` is the now-lower `quantity`, so `pre > minQuantity` fails. The
 * second tx therefore never reaches the flip from a downward crossing —
 * and under the spec scenario's parameters (qty=10, drop=5, min=3), the
 * second tx sees newQty=0 (still satisfies the gate) ONLY if the first
 * tx's newQty was above the gate, in which case the second tx's `pre`
 * would be too low. So this spec naturally resolves to: one crossing tx,
 * one non-crossing tx, exactly one outbox row.
 *
 * The barrier mentioned by the reviewer (advisory lock between PRE-gate
 * and flip) is not required for this scenario — Postgres's row-level
 * lock on `products` already orders the two UPDATEs, and the
 * `INSERT stock_alert_states ... ON CONFLICT DO NOTHING` plus the
 * conditional `UPDATE ... WHERE alerted=false RETURNING` already
 * implements the count=1 / count=0 contract. The barrier would only
 * matter if both txs could independently trigger a fresh crossing on
 * the same (tenantId, productId, variantKey) tuple, which the strict-`>`
 * PRE-gate forbids.
 *
 * If the test database is unreachable, the spec SKIPS gracefully — the
 * branch coverage spec provides analogous guarantees via mocks.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantPrismaService } from '../src/shared/prisma/tenant-prisma.service';
import { PrismaProductRepository } from '../src/products/infrastructure/prisma-product.repository';
import { PrismaStockAlertStateRepository } from '../src/stock-alerts/infrastructure/prisma-stock-alert-state.repository';
import { OutboxWriterService } from '../src/shared/outbox/outbox-writer.service';
import type { TenantClsStore } from '../src/shared/tenant/tenant-cls-store.interface';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = process.env.SKIP_DB_INTEGRATION === '1';

const describeIfDb = SKIP_INTEGRATION || !DATABASE_URL ? describe.skip : describe;

describeIfDb(
  'Slice E.4 — real-DB concurrent transaction collapse (driven through production repos)',
  () => {
    let prisma: PrismaClient;
    let cls: ClsService<TenantClsStore>;
    let tenantPrisma: TenantPrismaService;
    let productRepo: PrismaProductRepository;
    let tenantId: string;
    let productId: string;

    beforeAll(() => {
      if (!DATABASE_URL) return;
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
      });
      const prismaService = new PrismaService();
      // ClsService needs an AsyncLocalStorage instance (ClsModule wires
      // this in production). For an integration spec we pass a private
      // ALS so `cls.run(() => ...)` and `cls.set/get` work without the
      // Nest module graph.
      cls = new ClsService<TenantClsStore>(
        new AsyncLocalStorage<Record<string, unknown>>(),
      );
      tenantPrisma = new TenantPrismaService(
        prismaService as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      const alertState = new PrismaStockAlertStateRepository();
      const outbox = new OutboxWriterService();
      productRepo = new PrismaProductRepository(
        tenantPrisma as unknown as ConstructorParameters<
          typeof PrismaProductRepository
        >[0],
        outbox,
        alertState,
      );
    });

    beforeEach(async () => {
      if (!prisma) return;
      tenantId = `e4tenant-${randomUUID()}`;
      // Minimum-viable tenant scaffolding — only fields with FK requirements
      // are populated. The cascade-deleted StockAlertState rows from
      // previous test runs cannot survive past tenant delete.
      await prisma.tenant.create({
        data: {
          id: tenantId,
          name: 'E4 Tenant',
          slug: `e4-tenant-${randomUUID()}`,
        },
      });
      productId = `e4prod-${randomUUID()}`;
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
          // Spec values: qty=10, min=3, drop=5 each.
          // Each sale drops 5; the crossing resolves to ONE alert
          // exactly once across the two transactions.
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
        where: { id: { startsWith: 'e4tenant-' } },
      });
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    it(
      'two concurrent sales: exactly one outbox row, exactly one non-empty crossings array (Promise.all through real repos)',
      async () => {
        if (!prisma) {
          throw new Error('Prisma client not initialized');
        }

        // Each sale is a single TenantPrismaService.runInTransaction call
        // that drives the REAL productRepo. The two sales are launched in
        // `Promise.all` — Postgres row-locks serialize the UPDATEs and
        // the conditional `UPDATE ... WHERE alerted=false RETURNING`
        // collapses any flip overlap to a single epoch.
        const runSale = (correlationId: string) =>
          cls.run(async () => {
            cls.set('tenantId', tenantId);
            return tenantPrisma.runInTransaction(async () =>
              productRepo.decrementStockForCharge([
                { productId, quantity: 5 },
              ]),
            ).then((crossings) => ({ correlationId, crossings }));
          });

        const [resultA, resultB] = await Promise.all([
          runSale('A'),
          runSale('B'),
        ]);

        // ── Spec outcome assertions ──────────────────────────────────
        const totalCrossings =
          resultA.crossings.length + resultB.crossings.length;
        expect(totalCrossings).toBe(1);

        const outboxRows = await prisma.outboxEvent.findMany({
          where: {
            tenantId,
            eventType: 'stock.low.detected',
          },
        });
        expect(outboxRows).toHaveLength(1);

        const stockAlertState = await prisma.stockAlertState.findFirst({
          where: { tenantId, productId },
        });
        expect(stockAlertState?.alerted).toBe(true);
        expect(stockAlertState?.alertEpoch).toBe(1);

        // Both UPDATEs ran (each tx committed its decrement).
        const product = await prisma.product.findUnique({
          where: { id: productId },
        });
        expect(product?.quantity).toBe(0);

        // The single outbox row carries the alertEpoch from the winner's
        // seedAndFlip (epoch=1) — proves the in-tx outbox write happened
        // inside the WINNER's transaction, not the loser's.
        expect(outboxRows[0].payload).toMatchObject({
          tenantId,
          productId,
          variantKey: '__PRODUCT__',
          alertEpoch: 1,
        });
      },
      30_000,
    );
  },
);
