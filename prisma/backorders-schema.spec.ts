/**
 * restock-backorder / T1 — schema + migration drift guard for the additive
 * backorder persistence (contract v1 §1; odd/tasks/restock-backorder.md S1).
 *
 * DB-free (fs only), mirrors `cash-register-schema.spec.ts`. Every invariant
 * is a database guarantee no unit mock can prove, so it is pinned twice: in the
 * Prisma DSL (`prisma/schema.prisma`) and in the raw DDL
 * (`prisma/migrations/20261120000000_backorders/migration.sql`). The
 * PostgreSQL behaviour of the same constraints is proven by
 * `src/backorders/backorders.integration.spec.ts`.
 *
 * Non-negotiable invariants:
 *   - tenant ownership on both tables; product / chatbot request / sale links
 *     are tenant-qualified composite FKs, every business FK is RESTRICT;
 *   - one ACTIVE (WAITING/RESERVED) backorder per customer + product + variant,
 *     NULL variants compared as equal (partial unique index over COALESCE);
 *   - idempotency key and folio unique per tenant, FIFO queue index;
 *   - additive only: no DROP/UPDATE/DELETE and no ALTER of any other table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TENANT_SCOPED_MODELS } from '../src/shared/tenant/tenant-scoped-models.constant';

describe('restock-backorder schema + migration drift guard (T1)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationFile = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20261120000000_backorders',
    'migration.sql',
  );
  const sql = fs.existsSync(migrationFile)
    ? fs.readFileSync(migrationFile, 'utf8')
    : '';
  // DDL only: header/rollback comments legitimately name DROP verbs.
  const ddl = sql.replace(/^\s*--.*$/gm, '');
  const flat = (fragment: string): string =>
    fragment.replace(/\s+/g, ' ').trim();
  const ddlFlat = flat(ddl);

  const model = (name: string): string =>
    schemaText.match(
      new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
    )?.[1] ?? '';

  const enumMembers = (name: string): string[] =>
    (
      schemaText.match(
        new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
      )?.[1] ?? ''
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

  const backorder = model('Backorder');

  it('ships the hand-written migration next to the latest one', () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
    expect(
      fs
        .readdirSync(path.join(process.cwd(), 'prisma', 'migrations'))
        .filter((name) => name.endsWith('_backorders')),
    ).toEqual(['20261120000000_backorders']);
  });

  it('declares the two enums with exactly the contracted members', () => {
    expect(enumMembers('BackorderStatus')).toEqual([
      'WAITING',
      'RESERVED',
      'CONFIRMED',
      'EXPIRED',
      'CANCELLED',
    ]);
    expect(enumMembers('BackorderCancelledByKind')).toEqual([
      'STAFF',
      'CUSTOMER',
    ]);
    expect(ddlFlat).toContain(
      `CREATE TYPE "BackorderStatus" AS ENUM ('WAITING', 'RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED')`,
    );
    expect(ddlFlat).toContain(
      `CREATE TYPE "BackorderCancelledByKind" AS ENUM ('STAFF', 'CUSTOMER')`,
    );
  });

  it('declares every §1 column in the model and in the table', () => {
    const columns: Array<[string, RegExp, string]> = [
      [
        'id',
        /^\s*id\s+String\s+@id\s+@default\(uuid\(\)\)\s*$/m,
        '"id" TEXT NOT NULL',
      ],
      ['tenantId', /^\s*tenantId\s+String\s*$/m, '"tenantId" TEXT NOT NULL'],
      ['folio', /^\s*folio\s+String\s*$/m, '"folio" TEXT NOT NULL'],
      [
        'status',
        /^\s*status\s+BackorderStatus\s+@default\(WAITING\)\s*$/m,
        `"status" "BackorderStatus" NOT NULL DEFAULT 'WAITING'`,
      ],
      [
        'version',
        /^\s*version\s+Int\s+@default\(1\)\s*$/m,
        '"version" INTEGER NOT NULL DEFAULT 1',
      ],
      [
        'customerId',
        /^\s*customerId\s+String\s*$/m,
        '"customerId" TEXT NOT NULL',
      ],
      ['productId', /^\s*productId\s+String\s*$/m, '"productId" TEXT NOT NULL'],
      ['variantId', /^\s*variantId\s+String\?\s*$/m, '"variantId" TEXT,'],
      ['quantity', /^\s*quantity\s+Int\s*$/m, '"quantity" INTEGER NOT NULL'],
      [
        'referencePriceCents',
        /^\s*referencePriceCents\s+Int\s*$/m,
        '"referencePriceCents" INTEGER NOT NULL',
      ],
      [
        'referencePriceListId',
        /^\s*referencePriceListId\s+String\?\s*$/m,
        '"referencePriceListId" TEXT,',
      ],
      [
        'currentPriceCents',
        /^\s*currentPriceCents\s+Int\?\s*$/m,
        '"currentPriceCents" INTEGER,',
      ],
      [
        'finalPriceCents',
        /^\s*finalPriceCents\s+Int\?\s*$/m,
        '"finalPriceCents" INTEGER,',
      ],
      [
        'scheduledAt',
        /^\s*scheduledAt\s+DateTime\s*$/m,
        '"scheduledAt" TIMESTAMP(3) NOT NULL',
      ],
      [
        'estimatedArrivalDays',
        /^\s*estimatedArrivalDays\s+Int\s*$/m,
        '"estimatedArrivalDays" INTEGER NOT NULL',
      ],
      [
        'estimatedAt',
        /^\s*estimatedAt\s+DateTime\s*$/m,
        '"estimatedAt" TIMESTAMP(3) NOT NULL',
      ],
      [
        'sourceDecisionId',
        /^\s*sourceDecisionId\s+String\s*$/m,
        '"sourceDecisionId" TEXT NOT NULL',
      ],
      [
        'chatbotRequestId',
        /^\s*chatbotRequestId\s+String\?\s*$/m,
        '"chatbotRequestId" TEXT,',
      ],
      [
        'reservedAt',
        /^\s*reservedAt\s+DateTime\?\s*$/m,
        '"reservedAt" TIMESTAMP(3),',
      ],
      [
        'reservedUntil',
        /^\s*reservedUntil\s+DateTime\?\s*$/m,
        '"reservedUntil" TIMESTAMP(3),',
      ],
      [
        'reminderAt',
        /^\s*reminderAt\s+DateTime\?\s*$/m,
        '"reminderAt" TIMESTAMP(3),',
      ],
      [
        'reservationStage',
        /^\s*reservationStage\s+Int\s+@default\(0\)\s+@db\.SmallInt\s*$/m,
        '"reservationStage" SMALLINT NOT NULL DEFAULT 0',
      ],
      [
        'etaStage',
        /^\s*etaStage\s+Int\s+@default\(0\)\s+@db\.SmallInt\s*$/m,
        '"etaStage" SMALLINT NOT NULL DEFAULT 0',
      ],
      [
        'passedOverCount',
        /^\s*passedOverCount\s+Int\s+@default\(0\)\s*$/m,
        '"passedOverCount" INTEGER NOT NULL DEFAULT 0',
      ],
      [
        'reestimateDecisionId',
        /^\s*reestimateDecisionId\s+String\?\s*$/m,
        '"reestimateDecisionId" TEXT,',
      ],
      [
        'confirmedAt',
        /^\s*confirmedAt\s+DateTime\?\s*$/m,
        '"confirmedAt" TIMESTAMP(3),',
      ],
      ['saleId', /^\s*saleId\s+String\?\s*$/m, '"saleId" TEXT,'],
      [
        'cancelledAt',
        /^\s*cancelledAt\s+DateTime\?\s*$/m,
        '"cancelledAt" TIMESTAMP(3),',
      ],
      [
        'cancelReason',
        /^\s*cancelReason\s+String\?\s+@db\.VarChar\(280\)\s*$/m,
        '"cancelReason" VARCHAR(280),',
      ],
      [
        'cancelledByKind',
        /^\s*cancelledByKind\s+BackorderCancelledByKind\?\s*$/m,
        '"cancelledByKind" "BackorderCancelledByKind",',
      ],
      [
        'cancelledByUserId',
        /^\s*cancelledByUserId\s+String\?\s*$/m,
        '"cancelledByUserId" TEXT,',
      ],
      [
        'expiredAt',
        /^\s*expiredAt\s+DateTime\?\s*$/m,
        '"expiredAt" TIMESTAMP(3),',
      ],
      [
        'idempotencyKey',
        /^\s*idempotencyKey\s+String\s*$/m,
        '"idempotencyKey" TEXT NOT NULL',
      ],
      [
        'requestHash',
        /^\s*requestHash\s+String\s*$/m,
        '"requestHash" TEXT NOT NULL',
      ],
      [
        'createdAt',
        /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
        '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      ],
      [
        'updatedAt',
        /^\s*updatedAt\s+DateTime\s+@updatedAt\s*$/m,
        '"updatedAt" TIMESTAMP(3) NOT NULL',
      ],
    ];
    expect(backorder).toMatch(/@@map\("backorders"\)/);
    const table =
      ddlFlat.match(
        /CREATE TABLE "backorders" \((.*?)CONSTRAINT "backorders_pkey"/,
      )?.[1] ?? '';
    for (const [name, dsl, column] of columns) {
      expect([name, dsl.test(backorder)]).toEqual([name, true]);
      expect([name, table.includes(column)]).toEqual([name, true]);
    }
    // No column beyond the contract: derived `reservedLotIds` is a read.
    expect(backorder).not.toMatch(/reservedLotIds/);
  });

  it('keeps the idempotency key and the folio unique per tenant', () => {
    expect(backorder).toMatch(
      /@@unique\(\s*\[tenantId,\s*idempotencyKey\]\s*\)/,
    );
    expect(backorder).toMatch(/@@unique\(\s*\[tenantId,\s*folio\]\s*\)/);
    expect(backorder).toMatch(/@@unique\(\s*\[tenantId,\s*id\]\s*\)/);
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "backorders_tenantId_idempotencyKey_key" ON "backorders"("tenantId", "idempotencyKey")',
    );
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "backorders_tenantId_folio_key" ON "backorders"("tenantId", "folio")',
    );
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "backorders_tenantId_id_key" ON "backorders"("tenantId", "id")',
    );
  });

  it('indexes the FIFO queue by (tenant, product, variant, status, scheduledAt, id)', () => {
    expect(backorder).toMatch(
      /@@index\(\s*\[tenantId,\s*productId,\s*variantId,\s*status,\s*scheduledAt,\s*id\],\s*map:\s*"backorders_queue_idx"\s*\)/,
    );
    expect(ddlFlat).toContain(
      'CREATE INDEX "backorders_queue_idx" ON "backorders"("tenantId", "productId", "variantId", "status", "scheduledAt", "id")',
    );
  });

  it('allows one ACTIVE backorder per customer+product+variant, NULL variants equal', () => {
    // Partial + expression: the migration is the only definition.
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "backorders_one_active_per_customer_product_variant_uq" ON "backorders"("tenantId", "customerId", "productId", (COALESCE("variantId", \'\')))',
    );
    expect(ddlFlat).toContain(`WHERE "status" IN ('WAITING', 'RESERVED')`);
    // The partial predicate must be the active statuses and nothing else.
    expect(ddlFlat).not.toMatch(
      /_uq"[^;]*WHERE "status" IN \([^)]*'(CONFIRMED|EXPIRED|CANCELLED)'/,
    );
    // Documented in the DSL so nobody "fixes" the drift by dropping it.
    expect(schemaText).toContain(
      'backorders_one_active_per_customer_product_variant_uq',
    );
  });

  it('is tenant-owned with tenant-qualified composite FKs and RESTRICT history', () => {
    expect(backorder).toMatch(
      /tenant\s+Tenant\s+@relation\(fields:\s*\[tenantId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade/,
    );
    for (const [field, target] of [
      ['product', 'Product'],
      ['chatbotRequest', 'ChatbotRequest\\?'],
      ['sale', 'Sale\\?'],
    ]) {
      expect(backorder).toMatch(
        new RegExp(
          `${field}\\s+${target}\\s+@relation\\(fields:\\s*\\[tenantId,\\s*${field}Id\\],\\s*references:\\s*\\[tenantId,\\s*id\\],\\s*onDelete:\\s*Restrict`,
        ),
      );
    }
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "chatbotRequestId") REFERENCES "chatbot_requests"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'ADD CONSTRAINT "backorders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE',
    );
    // customers / variants / human_decisions have no (tenantId, id) unique and
    // are not altered: plain id FKs, RESTRICT so history is never erased.
    for (const [column, table] of [
      ['variantId', 'variants'],
      ['customerId', 'customers'],
      ['sourceDecisionId', 'human_decisions'],
      ['reestimateDecisionId', 'human_decisions'],
    ]) {
      expect(ddlFlat).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "${table}"("id") ON DELETE RESTRICT`,
      );
    }
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL',
    );
    // The two decision links are distinct named relations.
    expect(backorder).toMatch(/"BackorderSourceDecision"/);
    expect(backorder).toMatch(/"BackorderReestimateDecision"/);
  });

  it('back-relates every target model so Prisma resolves the graph', () => {
    expect(model('Tenant')).toMatch(/backorders\s+Backorder\[\]/);
    expect(model('Tenant')).toMatch(
      /backorderFolioCounter\s+BackorderFolioCounter\?/,
    );
    for (const name of [
      'Customer',
      'Product',
      'Variant',
      'Sale',
      'ChatbotRequest',
    ]) {
      expect([name, /backorders\s+Backorder\[\]/.test(model(name))]).toEqual([
        name,
        true,
      ]);
    }
    expect(model('HumanDecision')).toMatch(
      /@relation\("BackorderSourceDecision"\)/,
    );
    expect(model('HumanDecision')).toMatch(
      /@relation\("BackorderReestimateDecision"\)/,
    );
    expect(model('User')).toMatch(/@relation\("BackorderCancelledBy"\)/);
  });

  it('guards ranges and the status <-> timestamp coupling with CHECKs', () => {
    const checks = [
      'backorders_folio_format',
      'backorders_idempotency_shape',
      'backorders_quantity_positive',
      'backorders_version_positive',
      'backorders_prices_non_negative',
      'backorders_final_price_not_above_reference',
      'backorders_estimated_days_range',
      'backorders_stage_range',
      'backorders_passed_over_non_negative',
      'backorders_cancelled_state',
      'backorders_cancelled_by_user_is_staff',
      'backorders_reserved_state',
      'backorders_waiting_state',
      'backorders_confirmed_state',
      'backorders_expired_state',
    ];
    for (const name of checks) {
      expect([
        name,
        ddlFlat.includes(`ADD CONSTRAINT "${name}" CHECK`),
      ]).toEqual([name, true]);
    }
    expect(ddlFlat).toContain(`"folio" ~ '^BO-[0-9]{6,}$'`);
    expect(ddlFlat).toContain('"quantity" >= 1');
    expect(ddlFlat).toContain(
      '"finalPriceCents" IS NULL OR "finalPriceCents" <= "referencePriceCents"',
    );
    // Same range as the RESTOCK decision's restockDays CHECK (1..365).
    expect(ddlFlat).toContain('"estimatedArrivalDays" BETWEEN 1 AND 365');
  });

  it('adds the per-tenant folio counter like the cash closing counter', () => {
    const counter = model('BackorderFolioCounter');
    expect(counter).toMatch(/@@map\("backorder_folio_counters"\)/);
    expect(counter).toMatch(/^\s*tenantId\s+String\s+@unique\s*$/m);
    expect(counter).toMatch(/^\s*lastNumber\s+Int\s+@default\(0\)\s*$/m);
    expect(counter).toMatch(
      /tenant\s+Tenant\s+@relation\(fields:\s*\[tenantId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade/,
    );
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "backorder_folio_counters_tenantId_key" ON "backorder_folio_counters"("tenantId")',
    );
    expect(ddlFlat).toContain('"lastNumber" INTEGER NOT NULL DEFAULT 0');
  });

  it('registers both models in the tenant-scoped allowlist (fail-open otherwise)', () => {
    expect(TENANT_SCOPED_MODELS.has('Backorder')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('BackorderFolioCounter')).toBe(true);
  });

  it('is additive: no destructive DDL, no DML and no ALTER of any other table', () => {
    expect(ddl).not.toMatch(/\bDROP\s+(TABLE|TYPE|INDEX|CONSTRAINT|COLUMN)\b/i);
    expect(ddl).not.toMatch(
      /^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im,
    );
    expect(ddl).not.toMatch(
      /\bALTER TABLE "(?!backorders"|backorder_folio_counters")/,
    );
    expect(ddl).not.toMatch(/\bALTER TYPE\b/i);
    const created = [...ddl.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(created.sort()).toEqual(['backorder_folio_counters', 'backorders']);
  });
});

/**
 * restock-backorder / T2a — journal vocabulary (contract v1 §3): the
 * hand-written enum migration `20261120010000_backorder_stock_movements`.
 * `ALTER TYPE ... ADD VALUE` is additive, and PostgreSQL forbids USING a value
 * added in the same transaction, so the file must hold nothing but the three
 * ADD VALUE statements (plus the lock timeout).
 */
describe('restock-backorder journal enum migration drift guard (T2a)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationDir = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20261120010000_backorder_stock_movements',
  );
  const sql = fs.existsSync(path.join(migrationDir, 'migration.sql'))
    ? fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8')
    : '';
  const ddl = sql
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const enumMembers = (name: string): string[] =>
    (
      schemaText.match(
        new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
      )?.[1] ?? ''
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

  it('sorts after the backorders migration and adds only enum values', () => {
    const names = fs
      .readdirSync(path.join(process.cwd(), 'prisma', 'migrations'))
      .filter((name) => name.endsWith('_backorder_stock_movements'));
    expect(names).toEqual(['20261120010000_backorder_stock_movements']);
    expect(
      '20261120010000_backorder_stock_movements' > '20261120000000_backorders',
    ).toBe(true);
    expect(ddl).toBe(
      [
        `SET LOCAL lock_timeout = '5s';`,
        `ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'BACKORDER_RESERVE';`,
        `ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'BACKORDER_RELEASE';`,
        `ALTER TYPE "StockMovementGroupType" ADD VALUE IF NOT EXISTS 'BACKORDER';`,
      ].join(' '),
    );
  });

  it('never uses a new value in the same migration (PostgreSQL forbids it inside the transaction)', () => {
    expect(ddl).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|SELECT)\b/i);
  });

  it('keeps the Prisma enums in step with the migration', () => {
    expect(enumMembers('StockMovementType')).toEqual([
      'OPENING',
      'INITIAL',
      'ADJUSTMENT',
      'SALE',
      'SALE_CANCELLATION',
      'REMOVAL',
      'BACKORDER_RESERVE',
      'BACKORDER_RELEASE',
    ]);
    expect(enumMembers('StockMovementGroupType')).toEqual([
      'SALE',
      'ADJUSTMENT',
      'PRODUCT',
      'BACKORDER',
    ]);
  });
});

/**
 * restock-backorder / T2b — the backorder-level feed subject (contract v1 §10):
 * `chatbot_feed_items.backorderId`, the widened subject CHECK, the exactly-once
 * partial unique index and the sweep's partial indexes. DB-free (fs only); the
 * PostgreSQL behaviour is proven by
 * `src/chatbot-requests/chatbot-feed-backorder-items.integration.spec.ts`.
 */
describe('restock-backorder feed migration drift guard (T2b)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationName = '20261121000000_backorder_feed';
  const outcomeMigrationName = '20261121000100_backorder_feed';
  const outcomeSql = fs.readFileSync(
    path.join(
      process.cwd(),
      'prisma',
      'migrations',
      outcomeMigrationName,
      'migration.sql',
    ),
    'utf8',
  );
  const outcomeDdl = outcomeSql
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const migrationFile = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    migrationName,
    'migration.sql',
  );
  const sql = fs.existsSync(migrationFile)
    ? fs.readFileSync(migrationFile, 'utf8')
    : '';
  const ddl = sql.replace(/^\s*--.*$/gm, '');
  const ddlFlat = ddl.replace(/\s+/g, ' ').trim();
  const feedItem =
    schemaText.match(/model ChatbotFeedItem\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '';

  it('ships two hand-written migrations after the stock-movement one (the second widens the outcome set)', () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
    const names = fs
      .readdirSync(path.join(process.cwd(), 'prisma', 'migrations'))
      .filter((name) => name.endsWith('_backorder_feed'));
    expect(names).toEqual([migrationName, outcomeMigrationName]);
    expect(migrationName > '20261120010000_backorder_stock_movements').toBe(
      true,
    );
  });

  it('adds the nullable backorderId and outcomeReason columns, in the model and in the table', () => {
    expect(feedItem).toMatch(/^\s*backorderId\s+String\?\s*$/m);
    expect(feedItem).toMatch(
      /^\s*outcomeReason\s+String\?\s+@db\.VarChar\(280\)\s*$/m,
    );
    expect(ddlFlat).toContain(
      'ALTER TABLE "chatbot_feed_items" ADD COLUMN "backorderId" TEXT, ADD COLUMN "outcomeReason" VARCHAR(280)',
    );
  });

  it('widens the subject CHECK to exactly one of requestId, saleId and backorderId', () => {
    expect(ddlFlat).toContain(
      'DROP CONSTRAINT "chatbot_feed_items_subject_chk"',
    );
    expect(ddlFlat).toContain(
      'ADD CONSTRAINT "chatbot_feed_items_subject_chk" CHECK (num_nonnulls("requestId", "saleId", "backorderId") = 1)',
    );
    expect(ddlFlat).toContain(
      'VALIDATE CONSTRAINT "chatbot_feed_items_subject_chk"',
    );
    // Documented in the DSL, where the CHECK cannot be declared.
    expect(feedItem).toContain('chatbot_feed_items_subject_chk');
  });

  it('widens the closed outcome set by exactly PROVIDER_REJECTED, keeping every old value', () => {
    expect(outcomeDdl).toContain(
      "ADD CONSTRAINT \"chatbot_feed_items_outcome_chk\" CHECK ( \"outcome\" IS NULL OR \"outcome\" IN ('PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION', 'STALE', 'PROVIDER_REJECTED') )",
    );
    expect(outcomeDdl).toContain(
      'VALIDATE CONSTRAINT "chatbot_feed_items_outcome_chk"',
    );
    // The ack-state CHECK needs no change: PROVIDER_REJECTED is terminal.
    expect(outcomeDdl).not.toContain('ack_state_chk');
    expect(outcomeDdl).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i);
    expect(
      new Set(
        [...outcomeDdl.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]),
      ),
    ).toEqual(new Set(['chatbot_feed_items']));
  });

  it('allows a reason only for PROVIDER_REJECTED', () => {
    expect(ddlFlat).toContain(
      'ADD CONSTRAINT "chatbot_feed_items_outcome_reason_chk" CHECK ("outcomeReason" IS NULL OR "outcome" = \'PROVIDER_REJECTED\')',
    );
  });

  it('is a tenant-qualified FK onto backorders, cascading with the backorder', () => {
    expect(feedItem).toMatch(
      /backorder\s+Backorder\?\s+@relation\(fields:\s*\[tenantId,\s*backorderId\],\s*references:\s*\[tenantId,\s*id\],\s*onDelete:\s*Cascade/,
    );
    expect(ddlFlat).toContain(
      'ADD CONSTRAINT "chatbot_feed_items_tenantId_backorderId_fkey" FOREIGN KEY ("tenantId", "backorderId") REFERENCES "backorders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(
      new RegExp('feedItems\\s+ChatbotFeedItem\\[\\]').test(
        schemaText.match(/model Backorder\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '',
      ),
    ).toBe(true);
  });

  it('keeps one item per backorder, type and backorder version (exactly once)', () => {
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "chatbot_feed_items_backorder_stage_uq" ON "chatbot_feed_items" ("tenantId", "backorderId", "type", (("payload" ->> \'version\'))) WHERE "backorderId" IS NOT NULL',
    );
    expect(schemaText).toContain('chatbot_feed_items_backorder_stage_uq');
  });

  it('adds the two partial indexes of the sweep', () => {
    expect(ddlFlat).toContain(
      'CREATE INDEX "backorders_reservation_due_idx" ON "backorders" ("reservedUntil", "id") WHERE "status" = \'RESERVED\' AND "reservationStage" < 2',
    );
    expect(ddlFlat).toContain(
      'CREATE INDEX "backorders_waiting_idx" ON "backorders" ("tenantId", "productId", "variantId") WHERE "status" = \'WAITING\'',
    );
  });

  it('is additive: no data change, no table or column dropped, nothing else altered', () => {
    expect(ddl).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE)\b/i,
    );
    expect(ddl).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|INDEX)/i);
    // The only DROP is the old subject CHECK, re-added in the same file.
    expect(ddl.match(/DROP\s+CONSTRAINT/gi)).toHaveLength(1);
    const altered = [...ddlFlat.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(altered)).toEqual(new Set(['chatbot_feed_items']));
    expect(ddlFlat).toContain("SET LOCAL lock_timeout = '5s'");
  });
});
