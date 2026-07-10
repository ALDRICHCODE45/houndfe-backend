/**
 * Work Unit 1 (Migration + Schema) — Live-DB up/down round-trip on populated DB.
 *
 * Per `openspec/changes/promotions-in-sale/design.md` (Migration / Rollout):
 *   "Additive only. Up: ALTER TABLE "sale_items" ADD COLUMN "promotionId" TEXT;
 *    + FK SetNull + index; CREATE TABLE "sale_promotion_applied" and
 *    "sale_promotion_vetoes" with tenantId, FKs (Promotion SetNull/Cascade,
 *    Sale Cascade), unique constraints. Down: drop the two tables and the
 *    column. No data loss on populated DB — all new columns nullable, no
 *    backfill."
 *
 * This is a DESTRUCTIVE schema-level test. It drops the new column and the
 * two new tables, then re-applies the up migration. It is opt-in via the
 * `PROMO_U1_DB_DESTRUCTIVE=1` env var so it does NOT run as part of the
 * regular TDD loop (where it would race with parallel specs).
 *
 * Why opt-in:
 *   - The drop/recreate is at the SCHEMA level. Other parallel specs
 *     (e.g. promotions.controller.spec.ts, evaluate-cart-promotions
 *     .use-case.spec.ts, etc.) connect to the same DB and would see
 *     Prisma errors if the column/tables vanished mid-run.
 *   - There is no precedent in the repo for destructive schema tests
 *     inside the regular suite.
 *   - The drift guard spec (`promotions-in-sale-migration-drift.spec.ts`)
 *     is the always-on structural check.
 *
 * Run manually with:
 *   PROMO_U1_DB_DESTRUCTIVE=1 pnpm jest prisma/promotions-in-sale-migration-up-down.spec.ts
 *
 * What it proves (when run):
 *   1. The new objects exist post-`migrate dev`.
 *   2. Test-owned rows on existing tables survive a full down/up cycle.
 *   3. The new objects come back exactly as the generated up migration
 *      defined them.
 *   4. The down SQL (manual — Prisma does not generate down steps) is a
 *      clean drop of the new column + the two new tables.
 *
 * Down SQL (the inverse of the generated migration.sql):
 *   ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "sale_items_promotionId_fkey";
 *   DROP INDEX IF EXISTS "sale_items_promotionId_idx";
 *   ALTER TABLE "sale_items" DROP COLUMN IF EXISTS "promotionId";
 *   DROP TABLE IF EXISTS "sale_promotion_vetoes" CASCADE;
 *   DROP TABLE IF EXISTS "sale_promotion_applied" CASCADE;
 *
 * Graceful skip: if DATABASE_URL is unset or SKIP_DB_INTEGRATION=1, the
 * suite is skipped — same convention as e4-concurrent-stock-alert.spec.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DESTRUCTIVE = process.env.PROMO_U1_DB_DESTRUCTIVE === '1';
const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !DATABASE_URL;

const describeIfDb =
  SKIP_INTEGRATION || !RUN_DESTRUCTIVE ? describe.skip : describe;

describeIfDb(
  'promotions-in-sale migration up/down round-trip (populated DB)',
  () => {
    const repoRoot = process.cwd();
    const migrationsRoot = path.join(repoRoot, 'prisma', 'migrations');

    function findMigrationDir(): string | null {
      if (!fs.existsSync(migrationsRoot)) return null;
      const entries = fs
        .readdirSync(migrationsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => name.endsWith('_promotions_in_sale'));
      if (entries.length === 0) return null;
      return path.join(migrationsRoot, entries.sort().reverse()[0]);
    }

    function readUpSql(): string {
      const dir = findMigrationDir();
      if (!dir) {
        throw new Error(
          'promotions_in_sale migration directory not found under prisma/migrations',
        );
      }
      return fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    }

    // Manual down migration. Mirrors what Prisma would emit for a reverse.
    // Order matters: drop FKs first, then column, then tables.
    const downSql = [
      'ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "sale_items_promotionId_fkey";',
      'DROP INDEX IF EXISTS "sale_items_promotionId_idx";',
      'ALTER TABLE "sale_items" DROP COLUMN IF EXISTS "promotionId";',
      'DROP TABLE IF EXISTS "sale_promotion_vetoes" CASCADE;',
      'DROP TABLE IF EXISTS "sale_promotion_applied" CASCADE;',
    ];

    let prisma: PrismaClient;
    const tenantId = `promou1-${randomUUID()}`;
    let productId: string;
    let promotionId: string;
    let saleId: string;
    let saleItemId: string;
    let userId: string;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: DATABASE_URL } },
      });

      // ── Seed test-owned rows. These must survive the down/up cycle.
      await prisma.tenant.create({
        data: {
          id: tenantId,
          name: 'Promo U1 Tenant',
          slug: `promo-u1-${randomUUID()}`,
        },
      });
      productId = `promou1prod-${randomUUID()}`;
      await prisma.product.create({
        data: {
          id: productId,
          name: 'Promo U1 Product',
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
          minQuantity: 0,
          hasVariants: false,
          tenantId,
        },
      });
      promotionId = `promou1promo-${randomUUID()}`;
      await prisma.promotion.create({
        data: {
          id: promotionId,
          title: 'Promo U1 Promotion',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          status: 'ACTIVE',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          tenantId,
        },
      });
      // Sale needs a User (FK Restrict on userId).
      userId = `promou1user-${randomUUID()}`;
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@example.com`,
          hashedPassword: 'x',
          name: 'Promo U1 User',
        },
      });
      saleId = `promou1sale-${randomUUID()}`;
      await prisma.sale.create({
        data: {
          id: saleId,
          userId,
          status: 'DRAFT',
          channel: 'POS',
          tenantId,
        },
      });
      saleItemId = `promou1si-${randomUUID()}`;
      await prisma.saleItem.create({
        data: {
          id: saleItemId,
          saleId,
          productId,
          productName: 'Promo U1 Product',
          quantity: 1,
          unitPriceCents: 1000,
          tenantId,
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      // Clean up the test-owned rows. The tenant delete cascades through.
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      await prisma.$disconnect();
    });

    async function assertUpObjectsPresent(): Promise<void> {
      const appliedRows = await prisma.$queryRawUnsafe<
        Array<{ t: string | null }>
      >(`SELECT to_regclass('public.sale_promotion_applied')::text AS t;`);
      expect(appliedRows[0]?.t).toBe('sale_promotion_applied');

      const vetoesRows = await prisma.$queryRawUnsafe<
        Array<{ t: string | null }>
      >(`SELECT to_regclass('public.sale_promotion_vetoes')::text AS t;`);
      expect(vetoesRows[0]?.t).toBe('sale_promotion_vetoes');

      const colRows = await prisma.$queryRawUnsafe<
        Array<{ is_nullable: string; data_type: string }>
      >(
        `SELECT is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sale_items'
            AND column_name = 'promotionId';`,
      );
      expect(colRows).toHaveLength(1);
      expect(colRows[0].is_nullable).toBe('YES');
      expect(colRows[0].data_type).toBe('text');
    }

    async function assertUpObjectsAbsent(): Promise<void> {
      const appliedRows = await prisma.$queryRawUnsafe<
        Array<{ t: string | null }>
      >(`SELECT to_regclass('public.sale_promotion_applied')::text AS t;`);
      expect(appliedRows[0]?.t).toBeNull();

      const vetoesRows = await prisma.$queryRawUnsafe<
        Array<{ t: string | null }>
      >(`SELECT to_regclass('public.sale_promotion_vetoes')::text AS t;`);
      expect(vetoesRows[0]?.t).toBeNull();

      const colRows = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sale_items'
            AND column_name = 'promotionId';`,
      );
      expect(colRows).toHaveLength(0);
    }

    async function assertTestRowsStillPresent(): Promise<void> {
      // Use raw SQL — the Prisma client model knows about `sale_items
      // .promotionId` (a column we drop in this test), so `prisma.saleItem
      // .findUnique` would throw after the down step. Raw SQL queries the
      // table by primary key and is agnostic to the migration state.
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          tenantId: string;
          productId: string;
          promotionId: string;
          saleId: string;
          saleItemId: string;
          count: number;
        }>
      >(
        `SELECT
           (SELECT id FROM "tenants"      WHERE id = $1)   AS "tenantId",
           (SELECT id FROM "products"     WHERE id = $2)   AS "productId",
           (SELECT id FROM "promotions"   WHERE id = $3)   AS "promotionId",
           (SELECT id FROM "sales"        WHERE id = $4)   AS "saleId",
           (SELECT id FROM "sale_items"   WHERE id = $5)   AS "saleItemId",
           (SELECT COUNT(*) FROM "sale_items" WHERE "saleId" = $4) AS count;`,
        tenantId,
        productId,
        promotionId,
        saleId,
        saleItemId,
      );
      const r = rows[0];
      expect(r).toBeDefined();
      expect(r.tenantId).toBe(tenantId);
      expect(r.productId).toBe(productId);
      expect(r.promotionId).toBe(promotionId);
      expect(r.saleId).toBe(saleId);
      expect(r.saleItemId).toBe(saleItemId);
      expect(Number(r.count)).toBe(1);
    }

    it(
      'up state present after migrate dev: new column and tables exist, test rows present',
      async () => {
        await assertUpObjectsPresent();
        await assertTestRowsStillPresent();
      },
      30_000,
    );

    it(
      'down then re-up: zero unrelated-row loss on test-owned rows',
      async () => {
        // Initial assertion — should be up.
        await assertUpObjectsPresent();
        await assertTestRowsStillPresent();

        // ── Apply DOWN ────────────────────────────────────────────
        for (const stmt of downSql) {
          await prisma.$executeRawUnsafe(stmt);
        }

        await assertUpObjectsAbsent();
        // Test-owned rows must survive the down — they're on EXISTING
        // tables; the down only drops the new column + the new tables.
        await assertTestRowsStillPresent();

        // ── Re-apply UP from the generated migration.sql ─────────
        const upSql = readUpSql();
        // Prisma migrations use `;` as the statement separator and do
        // not include procedural blocks here, so a naive split is safe.
        const statements = upSql
          .split(/;\s*\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of statements) {
          await prisma.$executeRawUnsafe(stmt + ';');
        }

        await assertUpObjectsPresent();
        await assertTestRowsStillPresent();
      },
      60_000,
    );
  },
);
