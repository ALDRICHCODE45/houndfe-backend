/**
 * Work Unit 1 (Migration + Schema) — Drift guard for `promotions_in_sale`.
 *
 * Per `openspec/changes/promotions-in-sale/design.md`:
 *   - `SaleItem.promotionId String?` FK `Promotion` onDelete SetNull + index
 *   - New model `SalePromotionApplied` (ORDER_DISCOUNT audit, one row per sale)
 *     with FK Sale Cascade, FK Promotion SetNull, `@@unique([saleId])`,
 *     `@@index([tenantId])`, mapped to `sale_promotion_applied`
 *   - New model `SalePromotionVeto` (per-draft veto set) with FK Sale Cascade,
 *     FK Promotion Cascade, `@@unique([saleId, promotionId])`,
 *     `@@index([tenantId])`, mapped to `sale_promotion_vetoes`
 *   - Back-relations on `Sale` and `Promotion`
 *
 * Constraints enforced:
 *   - ADDITIVE ONLY. No `DROP COLUMN`, no destructive renames.
 *   - New column is nullable. No backfill.
 *   - New tables carry `tenantId` consistent with existing multi-tenant tables.
 *
 * The pattern (parse schema + migration SQL text) mirrors the existing
 * `low-stock-migration-drift.spec.ts` — cheap, lives in the TDD loop, and
 * catches regressions if anyone hand-edits the generated migration.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('promotions-in-sale migration drift guard (U1)', () => {
  const repoRoot = process.cwd();
  const schemaPath = path.join(repoRoot, 'prisma', 'schema.prisma');
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

  const schemaText = (() => {
    try {
      return fs.readFileSync(schemaPath, 'utf8');
    } catch {
      return '';
    }
  })();

  // ---------------------------------------------------------------------------
  // Schema assertions — RED until 1.2 lands
  // ---------------------------------------------------------------------------

  function extractModel(name: string): string | null {
    const re = new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
    const match = schemaText.match(re);
    return match ? match[1] : null;
  }

  it('schema declares SaleItem.promotionId String? with FK to Promotion onDelete SetNull', () => {
    const body = extractModel('SaleItem');
    expect(body).not.toBeNull();
    expect(body!).toMatch(
      /^\s*promotionId\s+String\?\s*$/m,
    );
    // FK with SetNull onDelete. The `Promotion?` is the optional relation type.
    expect(body!).toMatch(
      /promotion\s+Promotion\?\s+@relation\([^)]*fields:\s*\[promotionId\][^)]*onDelete:\s*SetNull[^)]*\)/m,
    );
  });

  it('schema indexes SaleItem.promotionId', () => {
    const body = extractModel('SaleItem');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/@@index\(\s*\[promotionId\]\s*\)/);
  });

  it('schema declares SalePromotionApplied model mapped to sale_promotion_applied', () => {
    expect(schemaText).toMatch(/^model SalePromotionApplied\s/m);
    const body = extractModel('SalePromotionApplied');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/@@map\("sale_promotion_applied"\)/);
  });

  it('SalePromotionApplied has tenantId, saleId (Cascade), promotionId (SetNull)', () => {
    const body = extractModel('SalePromotionApplied');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/tenantId\s+String/);
    // FK Sale Cascade
    expect(body!).toMatch(
      /sale\s+Sale\s+@relation\([^)]*fields:\s*\[saleId\][^)]*onDelete:\s*Cascade[^)]*\)/m,
    );
    // FK Promotion SetNull. The `Promotion?` is the optional relation type.
    expect(body!).toMatch(
      /promotion\s+Promotion\?\s+@relation\([^)]*fields:\s*\[promotionId\][^)]*onDelete:\s*SetNull[^)]*\)/m,
    );
    // @@unique([saleId]) — one row per sale (ORDER)
    expect(body!).toMatch(/@@unique\(\s*\[saleId\]\s*\)/);
    // @@index([tenantId])
    expect(body!).toMatch(/@@index\(\s*\[tenantId\]\s*\)/);
  });

  it('SalePromotionApplied stores the applied discount snapshot fields', () => {
    const body = extractModel('SalePromotionApplied');
    expect(body).not.toBeNull();
    // discountType SaleItemDiscountType? (audit snapshot)
    expect(body!).toMatch(
      /discountType\s+SaleItemDiscountType\?/,
    );
    // discountValue Int? (raw value at apply time)
    expect(body!).toMatch(/discountValue\s+Int\?/);
    // discountAmountCents Int (computed at apply time)
    expect(body!).toMatch(/discountAmountCents\s+Int/);
    // discountTitle String? (denormalized for display)
    expect(body!).toMatch(/discountTitle\s+String\?/);
  });

  it('schema declares SalePromotionVeto model mapped to sale_promotion_vetoes', () => {
    expect(schemaText).toMatch(/^model SalePromotionVeto\s/m);
    const body = extractModel('SalePromotionVeto');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/@@map\("sale_promotion_vetoes"\)/);
  });

  it('SalePromotionVeto has tenantId, saleId (Cascade), promotionId (Cascade), unique(saleId,promotionId)', () => {
    const body = extractModel('SalePromotionVeto');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/tenantId\s+String/);
    // promotionId is non-null and Cascade so the @@unique([saleId, promotionId])
    // constraint stays well-defined (Postgres treats NULLs as distinct in
    // unique indexes — nullable would allow duplicate NULL rows for the same
    // saleId). Mirrors PromotionTargetItem / PromotionCustomer / etc.
    expect(body!).toMatch(/promotionId\s+String\s*$/m);
    expect(body!).toMatch(
      /sale\s+Sale\s+@relation\([^)]*fields:\s*\[saleId\][^)]*onDelete:\s*Cascade[^)]*\)/m,
    );
    expect(body!).toMatch(
      /promotion\s+Promotion\s+@relation\([^)]*fields:\s*\[promotionId\][^)]*onDelete:\s*Cascade[^)]*\)/m,
    );
    expect(body!).toMatch(/@@unique\(\s*\[saleId,\s*promotionId\]\s*\)/);
    expect(body!).toMatch(/@@index\(\s*\[tenantId\]\s*\)/);
  });

  it('Sale has back-relations to SalePromotionApplied and SalePromotionVeto', () => {
    const body = extractModel('Sale');
    expect(body).not.toBeNull();
    expect(body!).toMatch(
      /appliedPromotion\s+SalePromotionApplied\?/,
    );
    expect(body!).toMatch(
      /promotionVetoes\s+SalePromotionVeto\[\]/,
    );
  });

  it('Promotion has back-relations to SaleItem, SalePromotionApplied, SalePromotionVeto', () => {
    const body = extractModel('Promotion');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/appliedItems\s+SaleItem\[\]/);
    expect(body!).toMatch(
      /appliedSales\s+SalePromotionApplied\[\]/,
    );
    expect(body!).toMatch(/saleVetoes\s+SalePromotionVeto\[\]/);
  });

  // ---------------------------------------------------------------------------
  // Migration assertions — RED until 1.3 lands (migration generated)
  // ---------------------------------------------------------------------------

  it('generated migration directory exists (promotions_in_sale)', () => {
    const dir = findMigrationDir();
    expect(dir).not.toBeNull();
    expect(fs.existsSync(path.join(dir!, 'migration.sql'))).toBe(true);
  });

  it('generated migration.sql ALTERs sale_items to add nullable promotionId with FK', () => {
    const dir = findMigrationDir();
    const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
    // nullable column
    expect(sql).toMatch(
      /ALTER TABLE "sale_items"\s+ADD COLUMN\s+"promotionId"\s+TEXT/m,
    );
    // FK SetNull
    expect(sql).toMatch(
      /FOREIGN KEY \("promotionId"\)\s+REFERENCES "promotions"\("id"\)\s+ON DELETE SET NULL/m,
    );
  });

  it('generated migration.sql adds an index on sale_items(promotionId)', () => {
    const dir = findMigrationDir();
    const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
    expect(sql).toMatch(
      /CREATE INDEX "sale_items_promotionId_idx"\s+ON "sale_items"\("promotionId"\)/,
    );
  });

  it('generated migration.sql CREATEs sale_promotion_applied and sale_promotion_vetoes', () => {
    const dir = findMigrationDir();
    const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE "sale_promotion_applied"');
    expect(sql).toContain('CREATE TABLE "sale_promotion_vetoes"');
  });

  it('generated migration.sql defines the right FKs on the new tables', () => {
    const dir = findMigrationDir();
    const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
    // sale_promotion_applied: saleId CASCADE, promotionId SET NULL (audit)
    expect(sql).toMatch(
      /FOREIGN KEY \("saleId"\)\s+REFERENCES "sales"\("id"\)\s+ON DELETE CASCADE/m,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("promotionId"\)\s+REFERENCES "promotions"\("id"\)\s+ON DELETE SET NULL/m,
    );
    // sale_promotion_vetoes: saleId CASCADE, promotionId CASCADE (non-null FK
    // so the (saleId, promotionId) unique pair stays well-defined)
    expect(sql).toMatch(
      /FOREIGN KEY \("saleId"\)\s+REFERENCES "sales"\("id"\)\s+ON DELETE CASCADE/m,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("promotionId"\)\s+REFERENCES "promotions"\("id"\)\s+ON DELETE CASCADE/m,
    );
  });

  it('generated migration.sql is additive only — no DROP COLUMN, no DROP TABLE on existing objects', () => {
    const dir = findMigrationDir();
    const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    // The only DROP TABLE statements in the down direction are expected to
    // target the new objects. Forward (up) is checked here.
    expect(sql).not.toMatch(/DROP\s+TABLE\s+"sales"/i);
    expect(sql).not.toMatch(/DROP\s+TABLE\s+"sale_items"/i);
    expect(sql).not.toMatch(/DROP\s+TABLE\s+"promotions"/i);
  });
});
