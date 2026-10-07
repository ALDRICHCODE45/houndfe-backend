/**
 * cash-register-closing / T2 — schema + migration drift guard for the
 * additive POS cash-register persistence foundation (S1, S3, S8).
 *
 * DB-free (fs only), mirrors `human-decisions-schema.spec.ts`. Every invariant
 * below is a database guarantee that no unit mock can prove, so it is pinned
 * twice: in the Prisma DSL (`prisma/schema.prisma`) and in the raw DDL
 * (`prisma/migrations/20261007000100_cash_register_closing/migration.sql`).
 *
 * Non-negotiable invariants:
 *   - tenant ownership on every cash table, with tenant-qualified composite
 *     FKs BETWEEN cash objects so the database — not the application — rejects
 *     a cross-tenant link;
 *   - append-only audit: `CashMovement` has no mutable timestamp / delete rail
 *     and its source identity is unique within the tenant;
 *   - `CashSession.openingHandoverId` is unique within the tenant for
 *     exactly-once float reuse;
 *   - at most one unreleased session per register via a SQL partial unique
 *     index on `(tenantId, registerId) WHERE "drawerReleasedAt" IS NULL`
 *     (Prisma DSL cannot express partial indexes — the migration is the
 *     authority);
 *   - non-negative money / revision and a signed delta direction per movement
 *     kind that also prohibits a zero operational delta;
 *   - `CREDIT` is rejected by a DB CHECK and there is no FK to `sales` /
 *     `sale_payments` yet: linkage is by movement source identity.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('cash-register-closing schema + migration drift guard (T2)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationFile = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20261007000100_cash_register_closing',
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

  const TENANT_FK =
    /tenant\s+Tenant\s+@relation\([^)]*fields:\s*\[tenantId\][^)]*onDelete:\s*Cascade[^)]*\)/;

  it('declares the four cash enums with exactly the contracted members', () => {
    expect(enumMembers('CashSessionStatus')).toEqual([
      'OPEN',
      'COUNTING',
      'SUBMITTED',
      'CLOSED',
    ]);
    expect(enumMembers('CashMovementKind')).toEqual([
      'SALE_PAYMENT',
      'SALE_CHANGE',
      'REFUND_SETTLEMENT',
      'CASH_IN',
      'CASH_OUT',
    ]);
    expect(enumMembers('CashCountKind')).toEqual([
      'DECLARATION',
      'VERIFICATION',
    ]);
    expect(enumMembers('CashHandoverKind')).toEqual(['WITHDRAWAL', 'FLOAT']);
  });

  it('declares CashRegister with tenant ownership and both uniqueness rails', () => {
    expect(schemaText).toMatch(/^model CashRegister\s/m);
    const register = model('CashRegister');
    expect(register).toMatch(/@@map\("cash_registers"\)/);
    expect(register).toMatch(
      /^\s*id\s+String\s+@id\s+@default\(uuid\(\)\)\s*$/m,
    );
    expect(register).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(register).toMatch(/^\s*name\s+String\s*$/m);
    expect(register).toMatch(/^\s*isActive\s+Boolean\s+@default\(true\)\s*$/m);
    expect(register).toMatch(
      /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
    );
    expect(register).toMatch(/^\s*updatedAt\s+DateTime\s+@updatedAt\s*$/m);
    expect(register).toMatch(TENANT_FK);
    expect(register).toMatch(/@@unique\(\s*\[tenantId,\s*name\]\s*\)/);
    expect(register).toMatch(/@@unique\(\s*\[tenantId,\s*id\]\s*\)/);
  });

  it('declares CashSession lifecycle columns, statuses and freeze snapshot', () => {
    const session = model('CashSession');
    expect(session).toMatch(/@@map\("cash_sessions"\)/);
    expect(session).toMatch(/^\s*registerId\s+String\s*$/m);
    expect(session).toMatch(/^\s*cashierUserId\s+String\s*$/m);
    expect(session).toMatch(/^\s*openingCents\s+Int\s*$/m);
    expect(session).toMatch(
      /^\s*status\s+CashSessionStatus\s+@default\(OPEN\)\s*$/m,
    );
    expect(session).toMatch(
      /^\s*openedAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
    );
    expect(session).toMatch(/^\s*frozenAt\s+DateTime\?\s*$/m);
    expect(session).toMatch(/^\s*submittedAt\s+DateTime\?\s*$/m);
    expect(session).toMatch(/^\s*closedAt\s+DateTime\?\s*$/m);
    expect(session).toMatch(/^\s*drawerReleasedAt\s+DateTime\?\s*$/m);
    expect(session).toMatch(/^\s*openingHandoverId\s+String\?\s*$/m);
    expect(session).toMatch(/^\s*expectedJson\s+Json\?\s*$/m);
    expect(session).toMatch(TENANT_FK);
  });

  it('uses tenant-qualified composite FKs between cash objects', () => {
    const session = model('CashSession');
    expect(session).toMatch(
      /register\s+CashRegister\s+@relation\([^)]*fields:\s*\[tenantId,\s*registerId\][^)]*references:\s*\[tenantId,\s*id\]/,
    );
    // A FLOAT handover funds at most one session per tenant (exactly-once).
    expect(session).toMatch(
      /@@unique\(\s*\[tenantId,\s*openingHandoverId\]\s*\)/,
    );
    expect(session).toMatch(
      /openingHandover\s+CashHandover\?\s+@relation\(\s*"CashSessionOpeningHandover",\s*fields:\s*\[tenantId,\s*openingHandoverId\],\s*references:\s*\[tenantId,\s*id\]/,
    );

    const movement = model('CashMovement');
    expect(movement).toMatch(
      /session\s+CashSession\s+@relation\([^)]*fields:\s*\[tenantId,\s*sessionId\][^)]*references:\s*\[tenantId,\s*id\]/,
    );

    const count = model('CashCount');
    expect(count).toMatch(
      /session\s+CashSession\s+@relation\([^)]*fields:\s*\[tenantId,\s*sessionId\][^)]*references:\s*\[tenantId,\s*id\]/,
    );

    const handover = model('CashHandover');
    expect(handover).toMatch(
      /sourceSession\s+CashSession\s+@relation\(\s*"CashHandoverSourceSession",\s*fields:\s*\[tenantId,\s*sourceSessionId\],\s*references:\s*\[tenantId,\s*id\]/,
    );
    expect(handover).toMatch(/@@unique\(\s*\[tenantId,\s*id\]\s*\)/);

    const closing = model('CashClosing');
    expect(closing).toMatch(
      /session\s+CashSession\s+@relation\([^)]*fields:\s*\[tenantId,\s*sessionId\][^)]*references:\s*\[tenantId,\s*id\]/,
    );

    // The migration must carry the same composite FKs, never a bare id.
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "registerId") REFERENCES "cash_registers"("tenantId", "id")',
    );
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "sessionId") REFERENCES "cash_sessions"("tenantId", "id")',
    );
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "sourceSessionId") REFERENCES "cash_sessions"("tenantId", "id")',
    );
    expect(ddlFlat).toContain(
      'FOREIGN KEY ("tenantId", "openingHandoverId") REFERENCES "cash_handovers"("tenantId", "id")',
    );
  });

  it('retains cashier / actor / recipient / creator / closer identities with Restrict', () => {
    const expectations: Array<[string, RegExp]> = [
      [
        'CashSession',
        /cashier\s+User\s+@relation\(\s*"CashSessionCashier",\s*fields:\s*\[cashierUserId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict/,
      ],
      [
        'CashMovement',
        /actor\s+User\s+@relation\(\s*"CashMovementActor",\s+fields:\s*\[actorUserId\],\s*references:\s*\[id\],\s+onDelete:\s*Restrict/,
      ],
      [
        'CashCount',
        /actor\s+User\s+@relation\(\s*"CashCountActor",\s+fields:\s*\[actorUserId\],\s*references:\s*\[id\],\s+onDelete:\s*Restrict/,
      ],
      [
        'CashHandover',
        /recipient\s+User\s+@relation\(\s*"CashHandoverRecipient",\s+fields:\s*\[recipientUserId\],\s*references:\s*\[id\],\s+onDelete:\s*Restrict/,
      ],
      [
        'CashHandover',
        /createdBy\s+User\s+@relation\(\s*"CashHandoverCreator",\s+fields:\s*\[createdByUserId\],\s*references:\s*\[id\],\s+onDelete:\s*Restrict/,
      ],
      [
        'CashClosing',
        /closedBy\s+User\s+@relation\(\s*"CashClosingActor",\s+fields:\s*\[closedByUserId\],\s*references:\s*\[id\],\s+onDelete:\s*Restrict/,
      ],
    ];
    for (const [name, pattern] of expectations) {
      expect(model(name)).toMatch(pattern);
    }
    // Required columns: a nullable actor without a retained snapshot is
    // forbidden (audit precision review).
    expect(model('CashSession')).toMatch(/^\s*cashierUserId\s+String\s*$/m);
    expect(model('CashMovement')).toMatch(/^\s*actorUserId\s+String\s*$/m);
    expect(model('CashCount')).toMatch(/^\s*actorUserId\s+String\s*$/m);
    expect(model('CashHandover')).toMatch(/^\s*recipientUserId\s+String\s*$/m);
    expect(model('CashHandover')).toMatch(/^\s*createdByUserId\s+String\s*$/m);
    expect(model('CashClosing')).toMatch(/^\s*closedByUserId\s+String\s*$/m);
    // DDL: every actor FK is ON DELETE RESTRICT.
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_sessions_cashierUserId_fkey" FOREIGN KEY ("cashierUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_movements_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_counts_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_handovers_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_handovers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_closings_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
  });

  it('declares the append-only CashMovement ledger with source uniqueness', () => {
    const movement = model('CashMovement');
    expect(movement).toMatch(/@@map\("cash_movements"\)/);
    expect(movement).toMatch(/^\s*kind\s+CashMovementKind\s*$/m);
    expect(movement).toMatch(/^\s*deltaCents\s+Int\s*$/m);
    expect(movement).toMatch(/^\s*method\s+SalePaymentMethod\s*$/m);
    expect(movement).toMatch(/^\s*channelKey\s+String\s*$/m);
    expect(movement).toMatch(/^\s*channelLabel\s+String\s*$/m);
    expect(movement).toMatch(/^\s*sourceType\s+String\s*$/m);
    expect(movement).toMatch(/^\s*sourceId\s+String\s*$/m);
    expect(movement).toMatch(/^\s*actorUserId\s+String\s*$/m);
    expect(movement).toMatch(/^\s*reason\s+String\?\s*$/m);
    expect(movement).toMatch(/^\s*occurredAt\s+DateTime\s*$/m);
    expect(movement).toMatch(
      /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
    );
    expect(movement).toMatch(
      /@@unique\(\s*\[tenantId,\s*sourceType,\s*sourceId\]\s*\)/,
    );
    // Append-only: no update/delete rail, no mutable timestamp.
    expect(movement).not.toMatch(/@updatedAt/);
    expect(movement).not.toMatch(/deletedAt/);
    // No direct FK to Sale / SalePayment yet — linkage by source identity.
    expect(movement).not.toMatch(/\bsale\s+Sale\b/);
    expect(movement).not.toMatch(/salePayment\s+SalePayment/);
  });

  it('declares CashCount with revision-monotonic identity and preserved lines', () => {
    const count = model('CashCount');
    expect(count).toMatch(/@@map\("cash_counts"\)/);
    expect(count).toMatch(/^\s*kind\s+CashCountKind\s*$/m);
    expect(count).toMatch(/^\s*revision\s+Int\s+@default\(1\)\s*$/m);
    expect(count).toMatch(/^\s*actorUserId\s+String\s*$/m);
    expect(count).toMatch(/^\s*linesJson\s+Json\s*$/m);
    expect(count).toMatch(/^\s*denominationsJson\s+Json\?\s*$/m);
    expect(count).toMatch(/^\s*notes\s+String\?\s*$/m);
    expect(count).toMatch(
      /@@unique\(\s*\[tenantId,\s*sessionId,\s*kind,\s*revision\]\s*\)/,
    );
  });

  it('declares CashHandover declared/received split with optional receipt proof', () => {
    const handover = model('CashHandover');
    expect(handover).toMatch(/@@map\("cash_handovers"\)/);
    expect(handover).toMatch(/^\s*kind\s+CashHandoverKind\s*$/m);
    expect(handover).toMatch(/^\s*declaredCents\s+Int\s*$/m);
    expect(handover).toMatch(/^\s*receivedCents\s+Int\?\s*$/m);
    expect(handover).toMatch(/^\s*notes\s+String\?\s*$/m);
    expect(handover).toMatch(/^\s*receiptNotes\s+String\?\s*$/m);
    expect(handover).toMatch(/^\s*receivedAt\s+DateTime\?\s*$/m);
  });

  it('retains the authenticated receipt actor on CashHandover (nullable until receipt)', () => {
    const handover = model('CashHandover');
    // Separate from the intended recipient so the service can require
    // receiptActor == recipient for same-person FLOAT while forbidding a
    // self-recorded WITHDRAWAL and self verification/closing.
    expect(handover).toMatch(/^\s*receivedByUserId\s+String\?\s*$/m);
    expect(handover).toMatch(
      /receivedBy\s+User\?\s+@relation\(\s*"CashHandoverReceiver",\s*fields:\s*\[receivedByUserId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict/,
    );
    expect(model('User')).toContain('"CashHandoverReceiver"');
    expect(ddlFlat).toContain('"receivedByUserId" TEXT');
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_handovers_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    // Receipt actor and receipt time are recorded together or not at all.
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_handovers_receipt_actor_state" CHECK',
    );
    expect(ddlFlat).toContain(
      '"receivedByUserId" IS NULL AND "receivedAt" IS NULL',
    );
    expect(ddlFlat).toContain(
      '"receivedByUserId" IS NOT NULL AND "receivedAt" IS NOT NULL',
    );
  });

  it('declares CashClosing immutability identity (session + folio) and CashCommand idempotency', () => {
    const closing = model('CashClosing');
    expect(closing).toMatch(/@@map\("cash_closings"\)/);
    expect(closing).toMatch(/^\s*sessionId\s+String\s*$/m);
    expect(closing).toMatch(/^\s*folio\s+String\s*$/m);
    expect(closing).toMatch(/^\s*closedByUserId\s+String\s*$/m);
    expect(closing).toMatch(/^\s*snapshotJson\s+Json\s*$/m);
    expect(closing).toMatch(/@@unique\(\s*\[tenantId,\s*sessionId\]\s*\)/);
    expect(closing).toMatch(/@@unique\(\s*\[tenantId,\s*folio\]\s*\)/);

    const command = model('CashCommand');
    expect(command).toMatch(/@@map\("cash_commands"\)/);
    expect(command).toMatch(/^\s*key\s+String\s*$/m);
    expect(command).toMatch(/^\s*requestHash\s+String\s*$/m);
    expect(command).toMatch(/^\s*responseJson\s+Json\s*$/m);
    expect(command).toMatch(/@@unique\(\s*\[tenantId,\s*key\]\s*\)/);
  });

  it('registers every cash model in the Tenant and User relation graphs', () => {
    const tenant = model('Tenant');
    for (const relation of [
      'cashRegisters',
      'cashSessions',
      'cashMovements',
      'cashCounts',
      'cashHandovers',
      'cashClosings',
      'cashCommands',
    ]) {
      expect(tenant).toMatch(
        new RegExp(`^\\s*${relation}\\s+Cash\\w+\\[\\]`, 'm'),
      );
    }
    const user = model('User');
    for (const relationName of [
      'CashSessionCashier',
      'CashMovementActor',
      'CashCountActor',
      'CashHandoverRecipient',
      'CashHandoverCreator',
      'CashClosingActor',
    ]) {
      expect(user).toContain(`"${relationName}"`);
    }
  });

  it('creates every cash enum, table, unique index and non-negative check in the migration', () => {
    expect(sql.length).toBeGreaterThan(0);
    for (const enumName of [
      'CashSessionStatus',
      'CashMovementKind',
      'CashCountKind',
      'CashHandoverKind',
    ]) {
      expect(ddlFlat).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }
    for (const table of [
      'cash_registers',
      'cash_sessions',
      'cash_movements',
      'cash_counts',
      'cash_handovers',
      'cash_closings',
      'cash_commands',
    ]) {
      expect(ddlFlat).toContain(`CREATE TABLE "${table}"`);
    }
    for (const index of [
      'cash_registers_tenantId_name_key',
      'cash_registers_tenantId_id_key',
      'cash_sessions_tenantId_id_key',
      'cash_sessions_tenantId_openingHandoverId_key',
      'cash_movements_tenantId_sourceType_sourceId_key',
      'cash_counts_tenantId_sessionId_kind_revision_key',
      'cash_handovers_tenantId_id_key',
      'cash_closings_tenantId_sessionId_key',
      'cash_closings_tenantId_folio_key',
      'cash_commands_tenantId_key_key',
    ]) {
      expect(ddlFlat).toContain(`CREATE UNIQUE INDEX "${index}"`);
    }
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_sessions_opening_cents_nonnegative" CHECK ("openingCents" >= 0)',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_counts_revision_positive" CHECK ("revision" >= 1)',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_handovers_declared_cents_nonnegative" CHECK ("declaredCents" >= 0)',
    );
    expect(ddlFlat).toContain(
      'CHECK ("receivedCents" IS NULL OR "receivedCents" >= 0)',
    );
  });

  it('enforces the one-unreleased-session-per-register partial unique index', () => {
    expect(ddlFlat).toContain(
      'CREATE UNIQUE INDEX "cash_sessions_one_unreleased_per_register" ON "cash_sessions"("tenantId", "registerId") WHERE "drawerReleasedAt" IS NULL',
    );
  });

  it('rejects CREDIT and pins the signed delta direction per movement kind', () => {
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_movements_method_not_credit" CHECK ("method" <> \'CREDIT\')',
    );
    expect(ddlFlat).toContain(
      'CONSTRAINT "cash_movements_delta_direction" CHECK',
    );
    for (const branch of [
      `"kind" = 'SALE_PAYMENT' AND "deltaCents" > 0`,
      `"kind" = 'SALE_CHANGE' AND "deltaCents" < 0`,
      `"kind" = 'REFUND_SETTLEMENT' AND "deltaCents" < 0`,
      `"kind" = 'CASH_IN' AND "deltaCents" > 0`,
      `"kind" = 'CASH_OUT' AND "deltaCents" < 0`,
    ]) {
      expect(ddlFlat).toContain(branch);
    }
  });

  it('is additive: no destructive DDL, no DML and no alteration of existing sale tables', () => {
    expect(ddl).not.toMatch(/\bDROP\s+(TABLE|TYPE|INDEX|CONSTRAINT)\b/i);
    expect(ddl).not.toMatch(/\bALTER TABLE "(?!cash_)/);
    // No data manipulation (note: `ON UPDATE CASCADE` is DDL, not `UPDATE ... SET`).
    expect(ddl).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(ddl).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(ddl).not.toMatch(/\bUPDATE\s+"\w+"\s+SET\b/i);
    // No linkage into existing sale/payment tables yet.
    expect(ddl).not.toMatch(/REFERENCES "sales"/);
    expect(ddl).not.toMatch(/REFERENCES "sale_payments"/);
    expect(ddl).not.toMatch(/REFERENCES "sale_refunds"/);
  });
});
