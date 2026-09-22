/**
 * promotion-capacity-alerts / pca-1a — drift guard for the product-unit
 * capacity foundation: `Promotion.maxProductUnits Int?` +
 * `consumedProductUnits Int @default(0)`, the tenant-scoped `PromotionUsage`
 * ledger mapped to `promotion_usages`, and the hand-authored additive
 * migration.
 *
 * DB-free, mirrors `promotions-in-sale-migration-drift.spec.ts`. Contract:
 * capacity is opt-in (NULL = unlimited), one aggregate usage row per
 * (tenant, sale, promotion), composite `(tenantId, id)` uniqueness on `Sale`
 * and `Promotion` so the DB rejects cross-tenant usage rows, and the migration
 * is additive with no historical usage backfill.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('promotion-capacity migration drift guard (pca-1a)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationFile = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260921233000_add_promotion_capacity_usage',
    'migration.sql',
  );
  const sql = fs.existsSync(migrationFile)
    ? fs.readFileSync(migrationFile, 'utf8')
    : '';
  // DDL only: the header comment documents the rollback (which names DROP
  // verbs), so destructive-statement assertions must ignore comment lines.
  const ddl = sql.replace(/^\s*--.*$/gm, '');

  // Missing model yields '' — every toMatch below then fails usefully.
  const model = (name: string): string =>
    schemaText.match(
      new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
    )?.[1] ?? '';

  const expectAll = (haystack: string, needles: string[]): void => {
    for (const needle of needles) expect(haystack).toContain(needle);
  };

  it('Promotion exposes opt-in capacity columns, ledger back-relation, and composite FK target', () => {
    const promotion = model('Promotion');
    // NULL = unlimited, so the "IS NULL OR > 0" DB check stays satisfiable.
    expect(promotion).toMatch(/^\s*maxProductUnits\s+Int\?\s*$/m);
    expect(promotion).toMatch(
      /^\s*consumedProductUnits\s+Int\s+@default\(0\)\s*$/m,
    );
    expect(promotion).toMatch(/usages\s+PromotionUsage\[\]/);
    expect(promotion).toMatch(/@@unique\(\s*\[tenantId,\s*id\]\s*\)/);
  });

  it('Sale exposes the ledger back-relation and a composite FK target', () => {
    const sale = model('Sale');
    expect(sale).toMatch(/promotionUsages\s+PromotionUsage\[\]/);
    expect(sale).toMatch(/@@unique\(\s*\[tenantId,\s*id\]\s*\)/);
  });

  it('PromotionUsage declares the mapped table, ledger columns, unique pair, and indexes', () => {
    const usage = model('PromotionUsage');
    expect(schemaText).toMatch(/^model PromotionUsage\s/m);
    expect(usage).toMatch(/@@map\("promotion_usages"\)/);
    expect(usage).toMatch(/^\s*id\s+String\s+@id\s+@default\(uuid\(\)\)\s*$/m);
    expect(usage).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(usage).toMatch(/^\s*saleId\s+String\s*$/m);
    expect(usage).toMatch(/^\s*promotionId\s+String\s*$/m);
    expect(usage).toMatch(/^\s*units\s+Int\s*$/m);
    expect(usage).toMatch(/^\s*restoredAt\s+DateTime\?\s*$/m);
    expect(usage).toMatch(
      /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
    );
    expect(usage).toMatch(
      /@@unique\(\s*\[tenantId,\s*saleId,\s*promotionId\]\s*\)/,
    );
    expect(usage).toMatch(
      /@@index\(\s*\[tenantId,\s*promotionId,\s*restoredAt\]\s*\)/,
    );
    expect(usage).toMatch(/@@index\(\s*\[tenantId,\s*saleId\]\s*\)/);
  });

  it('PromotionUsage owns composite tenant FKs to Sale and Promotion', () => {
    const usage = model('PromotionUsage');
    expect(usage).toMatch(
      /sale\s+Sale\s+@relation\([^)]*fields:\s*\[tenantId,\s*saleId\][^)]*references:\s*\[tenantId,\s*id\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(usage).toMatch(
      /promotion\s+Promotion\s+@relation\([^)]*fields:\s*\[tenantId,\s*promotionId\][^)]*references:\s*\[tenantId,\s*id\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(usage).toMatch(
      /tenant\s+Tenant\s+@relation\([^)]*fields:\s*\[tenantId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
  });

  it('migration exists and adds the populated-safe capacity columns', () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
    // Nullable, no default: unlimited promotions stay valid.
    expect(sql).toMatch(/"maxProductUnits"\s+INTEGER/);
    expect(sql).not.toMatch(/"maxProductUnits"\s+INTEGER\s+NOT NULL/);
    // The DB default IS the backfill for existing promotions (PG11+ fast
    // default) and keeps future inserts valid.
    expect(sql).toMatch(
      /"consumedProductUnits"\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/,
    );
  });

  it('migration creates promotion_usages with the ledger columns', () => {
    expect(sql).toContain('CREATE TABLE "promotion_usages"');
    expectAll(sql, [
      'CONSTRAINT "promotion_usages_pkey" PRIMARY KEY ("id")',
      '"id" TEXT NOT NULL',
      '"tenantId" TEXT NOT NULL',
      '"saleId" TEXT NOT NULL',
      '"promotionId" TEXT NOT NULL',
      '"units" INTEGER NOT NULL',
      '"restoredAt" TIMESTAMP(3)',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]);
  });

  it('migration enforces the capacity CHECK constraints in the database', () => {
    // Comment-stripped DDL: the rollback comment names these constraints, so
    // asserting against `sql` would pass even if the checks were removed.
    expectAll(ddl, [
      'CONSTRAINT "promotions_max_product_units_positive"',
      'CONSTRAINT "promotions_consumed_product_units_nonnegative"',
      'CONSTRAINT "promotions_consumed_within_max_product_units"',
      'CONSTRAINT "promotion_usages_units_positive"',
    ]);
    expect(sql).toMatch(
      /"maxProductUnits"\s+IS NULL\s+OR\s+"maxProductUnits"\s*>\s*0/,
    );
    expect(sql).toMatch(/"consumedProductUnits"\s*>=\s*0/);
    expect(sql).toMatch(
      /"maxProductUnits"\s+IS NULL\s+OR\s+"consumedProductUnits"\s*<=\s*"maxProductUnits"/,
    );
    expect(sql).toMatch(/"units"\s*>\s*0/);
  });

  it('migration adds the composite tenant unique targets and ledger indexes', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "sales_tenantId_id_key"\s+ON "sales"\("tenantId", "id"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "promotions_tenantId_id_key"\s+ON "promotions"\("tenantId", "id"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "promotion_usages_tenantId_saleId_promotionId_key"\s+ON "promotion_usages"\("tenantId", "saleId", "promotionId"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "promotion_usages_tenantId_promotionId_restoredAt_idx"\s+ON "promotion_usages"\("tenantId", "promotionId", "restoredAt"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "promotion_usages_tenantId_saleId_idx"\s+ON "promotion_usages"\("tenantId", "saleId"\)/,
    );
  });

  it('migration FKs match the schema delete/update behavior', () => {
    expectAll(ddl, [
      'CONSTRAINT "promotion_usages_tenantId_fkey"',
      'CONSTRAINT "promotion_usages_tenantId_saleId_fkey"',
      'CONSTRAINT "promotion_usages_tenantId_promotionId_fkey"',
    ]);
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId"\)\s+REFERENCES "tenants"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId", "saleId"\)\s+REFERENCES "sales"\("tenantId", "id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId", "promotionId"\)\s+REFERENCES "promotions"\("tenantId", "id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
  });

  it('migration is additive-only with no historical usage backfill', () => {
    expect(ddl).not.toMatch(/INSERT INTO "promotion_usages"/i);
    expect(ddl).not.toMatch(/UPDATE "promotion_usages"/i);
    // Any drop anywhere is rejected — stronger than naming tables individually.
    expect(ddl).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT|INDEX|TABLE)/i);
    expect(ddl).not.toMatch(/ALTER\s+COLUMN[^;]*DROP\s+NOT\s+NULL/i);
  });

  it('migration documents the exact manual rollback objects', () => {
    // Includes the composite unique indexes introduced on existing tables.
    expect(sql).toMatch(/Rollback/i);
    expectAll(sql, [
      'promotion_usages',
      'sales_tenantId_id_key',
      'promotions_tenantId_id_key',
      'maxProductUnits',
      'consumedProductUnits',
      'promotions_max_product_units_positive',
      'promotions_consumed_product_units_nonnegative',
      'promotions_consumed_within_max_product_units',
      'promotion_usages_units_positive',
    ]);
  });
});
