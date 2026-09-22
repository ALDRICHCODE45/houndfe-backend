/**
 * promotion-capacity-alerts / pca-3a1 — drift guard for
 * `PromotionExpiryAlertState` (`promotion_expiry_alert_states`) and its
 * hand-authored additive migration. DB-free, mirrors
 * `promotion-capacity-migration-drift.spec.ts`. Contract: one durable row per
 * (tenant, promotion, effective endDate fingerprint), so an A→B→A endDate
 * change reuses the A row and the same effective endDate can never re-alert.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('promotion expiry alert state migration drift guard (pca-3a1)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationFile = path.join(
    process.cwd(),
    'prisma/migrations/20260922181300_add_promotion_expiry_alert_state/migration.sql',
  );
  const sql = fs.existsSync(migrationFile)
    ? fs.readFileSync(migrationFile, 'utf8')
    : '';
  // DDL only: the rollback header names DROP verbs, so destructive-statement
  // and constraint assertions must ignore comment lines.
  const ddl = sql.replace(/^\s*--.*$/gm, '');

  // Missing model yields '' — every toContain below then fails usefully.
  // Whitespace is collapsed so column alignment never affects the contract.
  const flat = (name: string): string =>
    (
      schemaText.match(
        new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
      )?.[1] ?? ''
    ).replace(/\s+/g, ' ');

  const expectAll = (haystack: string, needles: string[]): void => {
    for (const needle of needles) expect(haystack).toContain(needle);
  };

  it('declares the mapped table, alert columns, unique fingerprint, and index', () => {
    const expiry = flat('PromotionExpiryAlertState');
    expect(expiry).toContain('@@map("promotion_expiry_alert_states")');
    expectAll(expiry, [
      'id String @id @default(uuid())',
      'tenantId String',
      'promotionId String',
      'endDateFingerprint String',
      'alerted Boolean @default(false)',
      'alertEpoch Int @default(0)',
      'alertedAt DateTime?',
      'createdAt DateTime @default(now())',
      'updatedAt DateTime @updatedAt',
      '@@index([tenantId])',
      // Fingerprint, not row id, is identity: A→B→A reuses the A row.
      '@@unique([tenantId, promotionId, endDateFingerprint], map: "promotion_expiry_alert_states_fingerprint_key")',
    ]);
  });

  it('owns tenant and composite promotion FKs plus reverse relation arrays', () => {
    const expiry = flat('PromotionExpiryAlertState');
    expect(expiry).toContain(
      'tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: Cascade)',
    );
    expect(expiry).toContain(
      'promotion Promotion @relation(fields: [tenantId, promotionId], references: [tenantId, id], onDelete: Cascade, onUpdate: Cascade)',
    );
    expect(flat('Tenant')).toContain(
      'promotionExpiryAlertStates PromotionExpiryAlertState[]',
    );
    expect(flat('Promotion')).toContain(
      'expiryAlertStates PromotionExpiryAlertState[]',
    );
  });

  it('migration creates the table with the alert columns and pkey', () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
    expectAll(sql, [
      'CREATE TABLE "promotion_expiry_alert_states"',
      'CONSTRAINT "promotion_expiry_alert_states_pkey" PRIMARY KEY ("id")',
      '"id" TEXT NOT NULL',
      '"tenantId" TEXT NOT NULL',
      '"promotionId" TEXT NOT NULL',
      '"endDateFingerprint" TEXT NOT NULL',
      '"alerted" BOOLEAN NOT NULL DEFAULT false',
      '"alertEpoch" INTEGER NOT NULL DEFAULT 0',
      '"alertedAt" TIMESTAMP(3)',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" TIMESTAMP(3) NOT NULL',
    ]);
  });

  it('migration enforces the fingerprint unique index, tenant index, and epoch check', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "promotion_expiry_alert_states_fingerprint_key"\s+ON "promotion_expiry_alert_states"\("tenantId", "promotionId", "endDateFingerprint"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "promotion_expiry_alert_states_tenantId_idx"\s+ON "promotion_expiry_alert_states"\("tenantId"\)/,
    );
    // Comment-stripped DDL: the rollback comment names the constraint, so
    // asserting against `sql` alone would pass even if the check were removed.
    expect(ddl).toContain(
      'CONSTRAINT "promotion_expiry_alert_states_alert_epoch_nonnegative"',
    );
    expect(ddl).toMatch(/"alertEpoch"\s*>=\s*0/);
  });

  it('migration FKs cascade like the schema and reuse the pca-1a composite target', () => {
    expectAll(ddl, [
      'CONSTRAINT "promotion_expiry_alert_states_tenantId_fkey"',
      'CONSTRAINT "promotion_expiry_alert_states_tenantId_promotionId_fkey"',
    ]);
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId"\)\s+REFERENCES "tenants"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId", "promotionId"\)\s+REFERENCES "promotions"\("tenantId", "id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
  });

  it('migration is additive-only with no backfill, drop, or capacity-alert table', () => {
    expect(sql).not.toMatch(/INSERT INTO "promotion_expiry_alert_states"/i);
    expect(sql).not.toMatch(/UPDATE "promotion_expiry_alert_states"/i);
    expect(ddl).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT|INDEX|TABLE)/i);
    expect(ddl).not.toMatch(/ALTER\s+COLUMN[^;]*DROP\s+NOT\s+NULL/i);
    expect(schemaText).not.toMatch(/model PromotionCapacityAlertState\s/);
  });

  it('migration documents the exact manual rollback objects', () => {
    expect(sql).toMatch(/Rollback/i);
    expectAll(sql, [
      'promotion_expiry_alert_states_fingerprint_key',
      'promotion_expiry_alert_states_tenantId_idx',
      'promotion_expiry_alert_states_alert_epoch_nonnegative',
    ]);
    expect(sql).toMatch(/DROP TABLE "promotion_expiry_alert_states"/);
  });
});
