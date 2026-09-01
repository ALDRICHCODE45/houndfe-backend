// F1.WU1b — Disposable PostgreSQL integration for online-catalog-publishing.
// Opt-in only: requires BOTH RUN_MIGRATION_DB_TESTS=1 AND MIGRATION_TEST_DATABASE_URL
// whose database name contains "test" (case-insensitive). When either guard fails
// the suite SKIPS honestly. Never reads the shared integration config or its
// globalSetup/globalTeardown.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
const RUN = process.env.RUN_MIGRATION_DB_TESTS === '1';
const URL_RAW = process.env.MIGRATION_TEST_DATABASE_URL;
const URL_OK = (() => {
  if (!URL_RAW) return false;
  try { return new URL(URL_RAW).pathname.replace(/^\//, '').toLowerCase().includes('test'); }
  catch { return false; }
})();
const ENABLED = RUN && URL_OK;
const dIf = ENABLED ? describe : describe.skip;
const MIG_SQL = (() => {
  const root = path.join(process.cwd(), 'prisma', 'migrations');
  const e = fs.readdirSync(root, { withFileTypes: true }).map((d) => d.name).filter((n) => n.endsWith('_online_catalog_publishing')).sort().reverse();
  if (!e.length) throw new Error('online_catalog_publishing migration not found');
  return fs.readFileSync(path.join(root, e[0], 'migration.sql'), 'utf8');
})();
function m4Insert(): string {
  const s = MIG_SQL.indexOf('INSERT INTO "tenant_catalog_price_lists"');
  if (s < 0) throw new Error('M4 INSERT not found');
  return MIG_SQL.slice(s, MIG_SQL.indexOf(';', s) + 1);
}
const BASE = [
  `CREATE TABLE "tenants" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL UNIQUE, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "global_price_lists" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "isDefault" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "categories" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "brands" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "products" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'PRODUCT', "tenantId" TEXT NOT NULL, "categoryId" TEXT, "brandId" TEXT, "unit" TEXT NOT NULL DEFAULT 'UNIDAD', "includeInOnlineCatalog" BOOLEAN NOT NULL DEFAULT true, "hidePriceInOnlineCatalog" BOOLEAN NOT NULL DEFAULT false, "hasVariants" BOOLEAN NOT NULL DEFAULT false, "useStock" BOOLEAN NOT NULL DEFAULT true, "quantity" INTEGER NOT NULL DEFAULT 0, "minQuantity" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "variants" ("id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL, "name" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "quantity" INTEGER NOT NULL DEFAULT 0, "minQuantity" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "price_lists" ("id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL, "globalPriceListId" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "priceCents" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `CREATE TABLE "variant_prices" ("id" TEXT PRIMARY KEY, "variantId" TEXT NOT NULL, "priceListId" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "priceCents" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);`,
  `ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;`,
  `ALTER TABLE "variants" ADD CONSTRAINT "variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE;`,
  `ALTER TABLE "variants" ADD CONSTRAINT "variants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;`,
  `ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;`,
  `ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;`,
].join('\n');
async function withSchema(fn: (c: Client) => Promise<void>) {
  const schema = `wu1b_${randomUUID().replace(/-/g, '')}`;
  const c = new Client({ connectionString: URL_RAW, options: `--search_path=${schema},public` });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public`);
    await c.query(BASE);
    await fn(c);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await c.end();
  }
}
const TS = 'NOW(),NOW()';
const GPL = (id: string, name: string, def: boolean) =>
  `INSERT INTO "global_price_lists" ("id","name","isDefault","createdAt","updatedAt") VALUES ('${id}','${name}',${def},${TS})`;
const T = (id: string) =>
  `INSERT INTO "tenants" ("id","name","slug","isActive","createdAt","updatedAt") VALUES ('${id}','${id}','${id}',true,${TS})`;
const TCP = (id: string, tid: string, gid: string, def: boolean) =>
  `INSERT INTO "tenant_catalog_price_lists" ("id","tenantId","globalPriceListId","isCatalogDefault","createdAt","updatedAt") VALUES ('${id}','${tid}','${gid}',${def},${TS})`;
async function seedExistingData(c: Client) {
  await c.query(GPL('g1', 'PUBLICO', true));
  await c.query(T('t1'));
  await c.query(`INSERT INTO "categories" ("id","name","createdAt","updatedAt") VALUES ('c1','Cat',${TS})`);
  await c.query(`INSERT INTO "brands" ("id","name","createdAt","updatedAt") VALUES ('b1','Brand',${TS})`);
  await c.query(`INSERT INTO "products" ("id","name","type","tenantId","categoryId","brandId","createdAt","updatedAt") VALUES ('p1','P1','PRODUCT','t1','c1','b1',${TS})`);
  await c.query(`INSERT INTO "variants" ("id","productId","name","tenantId","createdAt","updatedAt") VALUES ('v1','p1','V1','t1',${TS})`);
}

dIf('online-catalog-publishing — real PostgreSQL evidence', () => {
  it('Existing-data case → M1 false, M3 INHERIT+null, M4 single binding, M5 SYSTEM_STATUS', async () => {
    await withSchema(async (c) => {
      await seedExistingData(c);
      await c.query(MIG_SQL);
      const m1 = await c.query<{ catalogPublished: boolean }>(`SELECT "catalogPublished" FROM "tenants" WHERE "id"='t1'`);
      expect(m1.rows[0].catalogPublished).toBe(false);
      const m3 = await c.query<{ catalogPublishMode: string; onlineStockPresentation: string | null }>(
        `SELECT "catalogPublishMode","onlineStockPresentation" FROM "variants" WHERE "id"='v1'`,
      );
      expect(m3.rows[0].catalogPublishMode).toBe('INHERIT');
      expect(m3.rows[0].onlineStockPresentation).toBeNull();
      const m4 = await c.query<{ globalPriceListId: string; isCatalogDefault: boolean }>(
        `SELECT "globalPriceListId","isCatalogDefault" FROM "tenant_catalog_price_lists" WHERE "tenantId"='t1'`,
      );
      expect(m4.rows).toEqual([{ globalPriceListId: 'g1', isCatalogDefault: true }]);
      const m5 = await c.query<{ onlineStockPresentation: string }>(`SELECT "onlineStockPresentation" FROM "products" WHERE "id"='p1'`);
      expect(m5.rows[0].onlineStockPresentation).toBe('SYSTEM_STATUS');
    });
  });
  it('M4 idempotency: re-running only the M4 INSERT keeps exactly one row', async () => {
    await withSchema(async (c) => {
      await c.query(GPL('g1', 'PUBLICO', true));
      await c.query(T('t1'));
      await c.query(MIG_SQL);
      const m4 = m4Insert();
      await c.query(m4);
      await c.query(m4);
      const { rows } = await c.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM "tenant_catalog_price_lists" WHERE "tenantId"='t1'`);
      expect(parseInt(rows[0].cnt, 10)).toBe(1);
    });
  });
  it('M4 admin binding preserved: PUBLICO never overwrites admin', async () => {
    await withSchema(async (c) => {
      await c.query(GPL('g1', 'PUBLICO', true));
      await c.query(GPL('g2', 'ADMIN', false));
      await c.query(T('t1'));
      await c.query(MIG_SQL);
      await c.query(TCP('admin-b', 't1', 'g2', false));
      await c.query(m4Insert());
      const { rows } = await c.query<{ globalPriceListId: string; isCatalogDefault: boolean }>(
        `SELECT "globalPriceListId","isCatalogDefault" FROM "tenant_catalog_price_lists" WHERE "tenantId"='t1' ORDER BY "createdAt"`,
      );
      expect(rows).toHaveLength(2);
      const byList = new Map(rows.map((r) => [r.globalPriceListId, r]));
      expect(byList.get('g1')?.isCatalogDefault).toBe(true);
      expect(byList.get('g2')?.isCatalogDefault).toBe(false);
    });
  });
  it('M4 preflight: no isDefault=true raises with GlobalPriceList message', async () => {
    await withSchema(async (c) => {
      await c.query(GPL('g1', 'NOT_DEFAULT', false));
      await c.query(T('t1'));
      await expect(c.query(MIG_SQL)).rejects.toThrow(/GlobalPriceList/i);
    });
  });
  it('partial unique: UPDATE promoting to default hits partial index (not compound)', async () => {
    await withSchema(async (c) => {
      await c.query(GPL('g1', 'PUBLICO', true));
      await c.query(GPL('g2', 'LIST2', false));
      await c.query(T('t1'));
      await c.query(MIG_SQL);
      await c.query(TCP('bn1', 't1', 'g2', false));
      await expect(
        c.query(`UPDATE "tenant_catalog_price_lists" SET "isCatalogDefault"=true, "updatedAt"=NOW() WHERE "id"='bn1'`),
      ).rejects.toThrow(/tenant_catalog_price_lists_one_default_per_tenant/i);
    });
  });
  it('non-negative CHECKs reject negative custom qty on tenants/products/variants', async () => {
    await withSchema(async (c) => {
      await seedExistingData(c);
      await c.query(MIG_SQL);
      await c.query(`UPDATE "variants" SET "onlineStockPresentationCustomQty"=10 WHERE "id"='v1'`);
      await expect(c.query(`UPDATE "tenants" SET "catalogStockPresentationDefaultCustomQty"=-1 WHERE "id"='t1'`)).rejects.toThrow(/tenants_catalog_stock_default_custom_qty_nonnegative/i);
      await expect(c.query(`UPDATE "products" SET "onlineStockPresentationCustomQty"=-1 WHERE "id"='p1'`)).rejects.toThrow(/products_online_stock_custom_qty_nonnegative/i);
      await expect(c.query(`UPDATE "variants" SET "onlineStockPresentationCustomQty"=-5 WHERE "id"='v1'`)).rejects.toThrow(/variants_online_stock_custom_qty_nonnegative/i);
    });
  });
  it('clean-preseed: zero tenants + zero defaults → full migration succeeds, tables exist, zero bindings', async () => {
    await withSchema(async (c) => {
      await c.query(MIG_SQL);
      const t = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('tenant_catalog_price_lists','product_catalog_price_lists') ORDER BY table_name`,
      );
      expect(t.rows.map((r) => r.table_name)).toEqual(['product_catalog_price_lists', 'tenant_catalog_price_lists']);
      const { rows } = await c.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM "tenant_catalog_price_lists"`);
      expect(parseInt(rows[0].cnt, 10)).toBe(0);
    });
  });
});
