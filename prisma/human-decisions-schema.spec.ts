/**
 * human-decisions-restock-v1 / HD-01 — schema + migration drift guard for the
 * RESTOCK human-decision inbox.
 *
 * DB-free (fs only), mirrors `promotion-capacity-migration-drift.spec.ts`.
 * Two uniqueness guarantees have no application-level fallback and therefore
 * MUST exist in the database as well as in the Prisma DSL:
 *
 *   - `unique (tenantId, source, sourceRequestId)` — idempotent bot intake
 *     identity (the bot UUID equals `X-Idempotency-Key`).
 *   - `unique (tenantId, source, supersedesDecisionId)` — at most one
 *     correlated successor per predecessor; PostgreSQL keeps NULLs distinct so
 *     first requests may repeat NULL.
 *
 * Corrective continuation (audit/projection blockers): the immutable intake
 * credential, the durable reviewer `{id,displayName}` snapshots, the ACK
 * `attemptedAt`/`evidenceCode` columns and the outcome/evidence consistency
 * CHECK are all pinned here, because no unit mock can prove a DB constraint.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('human-decisions RESTOCK schema + migration drift guard (HD-01)', () => {
  const schemaText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationFile = path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260925000100_human_decisions_restock',
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

  const enumMembers = (name: string): string[] =>
    (
      schemaText.match(
        new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
      )?.[1] ?? ''
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

  const expectAll = (haystack: string, needles: string[]): void => {
    for (const needle of needles) expect(haystack).toContain(needle);
  };

  // Collapse a multi-line SQL/DDL fragment so CHECK bodies can be pinned as
  // readable substrings instead of whitespace-fragile regexes.
  const flat = (fragment: string): string =>
    fragment.replace(/\s+/g, ' ').trim();

  // Body of `ALTER TABLE ... ADD CONSTRAINT "<name>"` up to its `);`.
  const checkBody = (source: string, name: string): string => {
    const start = source.indexOf(`ADD CONSTRAINT "${name}"`);
    if (start < 0) return '';
    return source.slice(start, source.indexOf(');', start));
  };

  it('declares HumanDecision with the mapped table and intake identity columns', () => {
    expect(schemaText).toMatch(/^model HumanDecision\s/m);
    const decision = model('HumanDecision');
    expect(decision).toMatch(/@@map\("human_decisions"\)/);
    expect(decision).toMatch(
      /^\s*id\s+String\s+@id\s+@default\(uuid\(\)\)\s*$/m,
    );
    expect(decision).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(decision).toMatch(/^\s*source\s+String\s*$/m);
    expect(decision).toMatch(/^\s*sourceRequestId\s+String\s*$/m);
    expect(decision).toMatch(
      /^\s*type\s+HumanDecisionType\s+@default\(RESTOCK\)\s*$/m,
    );
    expect(decision).toMatch(/^\s*canonicalRequestHash\s+String\s*$/m);
    // Audit-only intake credential: server-derived from ServiceAuthGuard,
    // EXCLUDED from the canonical hash (rotation must not change identity), and
    // deliberately not an FK so a revoked/deleted credential can never erase or
    // block the intake audit.
    expect(decision).toMatch(/^\s*submittedCredentialId\s+String\s*$/m);
    expect(decision).not.toMatch(/submittedCredential\s+ServiceCredential/);
    expect(ddl).not.toMatch(/REFERENCES\s+"service_credentials"/);
  });

  it('declares the tenant-derived snapshot columns and the optional successor pointer', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(/^\s*branchId\s+String\s*$/m);
    expect(decision).toMatch(/^\s*branchName\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*productId\s+String\s*$/m);
    expect(decision).toMatch(/^\s*productName\s+String\s*$/m);
    expect(decision).toMatch(/^\s*variantId\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*sku\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*requestedQuantity\s+Int\?\s*$/m);
    expect(decision).toMatch(/^\s*observedStockAtRequest\s+Int\?\s*$/m);
    expect(decision).toMatch(/^\s*stockObservedAt\s+DateTime\?\s*$/m);
    expect(decision).toMatch(/^\s*supersedesDecisionId\s+String\?\s*$/m);
  });

  it('declares the PENDING|RESOLVED audit columns with a version CAS token', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(
      /^\s*status\s+HumanDecisionStatus\s+@default\(PENDING\)\s*$/m,
    );
    expect(decision).toMatch(/^\s*version\s+Int\s+@default\(1\)\s*$/m);
    expect(decision).toMatch(
      /^\s*resolutionAction\s+HumanDecisionResolutionAction\?\s*$/m,
    );
    expect(decision).toMatch(/^\s*restockDays\s+Int\?\s*$/m);
    expect(decision).toMatch(/^\s*resolutionRequestId\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*resolvedAt\s+DateTime\?\s*$/m);
    expect(decision).toMatch(/^\s*resolvedById\s+String\?\s*$/m);
  });

  it('declares the terminal bot outcome columns, with PENDING_DELIVERY derived from NULL', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(
      /^\s*applicationOutcome\s+HumanDecisionBotOutcome\?\s*$/m,
    );
    expect(decision).toMatch(/^\s*applicationAttemptId\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*applicationEvidenceHash\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*applicationEvidenceCode\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*providerMessageId\s+String\?\s*$/m);
    expect(decision).toMatch(
      /^\s*providerAcceptedObservedAt\s+DateTime\?\s*$/m,
    );
    expect(decision).toMatch(/^\s*applicationAttemptedAt\s+DateTime\?\s*$/m);
    expect(decision).toMatch(/^\s*ackReceivedAt\s+DateTime\?\s*$/m);
    // A terminal outcome set is the whole reason a stored PENDING_DELIVERY
    // member must NOT exist: before the first ACK the column is NULL.
    expect(enumMembers('HumanDecisionBotOutcome')).not.toContain(
      'PENDING_DELIVERY',
    );
  });

  it('declares created/updated timestamps and stable list ordering support', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(
      /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)\s*$/m,
    );
    expect(decision).toMatch(/^\s*updatedAt\s+DateTime\s+@updatedAt\s*$/m);
    expect(decision).toMatch(
      /@@index\(\s*\[tenantId,\s*status,\s*createdAt,\s*id\]\s*\)/,
    );
  });

  it('pins both composite uniques in the Prisma DSL', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(
      /@@unique\(\s*\[tenantId,\s*source,\s*sourceRequestId\]\s*\)/,
    );
    expect(decision).toMatch(
      /@@unique\(\s*\[tenantId,\s*source,\s*supersedesDecisionId\]\s*\)/,
    );
  });

  it('pins the tenant relation and the optional resolvedBy User relation', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(
      /tenant\s+Tenant\s+@relation\([^)]*fields:\s*\[tenantId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(decision).toMatch(
      /resolvedBy\s+User\?\s+@relation\(\s*"HumanDecisionResolver",\s*fields:\s*\[resolvedById\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull/,
    );
    // Both back-references must exist or Prisma cannot resolve the relations.
    expect(model('Tenant')).toMatch(/humanDecisions\s+HumanDecision\[\]/);
    expect(model('User')).toMatch(
      /humanDecisionResolutions\s+HumanDecision\[\]\s+@relation\("HumanDecisionResolver"\)/,
    );
  });

  it('declares the exact approved enum members', () => {
    expect(schemaText).toMatch(/^enum HumanDecisionType\s/m);
    expect(enumMembers('HumanDecisionType')).toEqual(['RESTOCK', 'EXPIRATION']);
    expect(enumMembers('HumanDecisionStatus')).toEqual(['PENDING', 'RESOLVED']);
    expect(enumMembers('HumanDecisionResolutionAction')).toEqual([
      'PROVIDE_RESTOCK_ESTIMATE',
      'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      'PROVIDE_EXPIRATION_TEXT',
      'REPORT_EXPIRATION_UNAVAILABLE',
    ]);
    expect(enumMembers('HumanDecisionBotOutcome')).toEqual([
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'DELIVERY_UNKNOWN',
      'STALE',
    ]);
  });

  it('migration exists and creates the enums plus the human_decisions table', () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
    expectAll(sql, [
      `CREATE TYPE "HumanDecisionType" AS ENUM ('RESTOCK')`,
      `CREATE TYPE "HumanDecisionStatus" AS ENUM ('PENDING', 'RESOLVED')`,
      `CREATE TYPE "HumanDecisionResolutionAction" AS ENUM ('PROVIDE_RESTOCK_ESTIMATE', 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE')`,
      `CREATE TYPE "HumanDecisionBotOutcome" AS ENUM ('PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'DELIVERY_UNKNOWN', 'STALE')`,
      'CREATE TABLE "human_decisions"',
      'CONSTRAINT "human_decisions_pkey" PRIMARY KEY ("id")',
      '"id" TEXT NOT NULL',
      '"tenantId" TEXT NOT NULL',
      '"source" TEXT NOT NULL',
      '"sourceRequestId" TEXT NOT NULL',
      `"type" "HumanDecisionType" NOT NULL DEFAULT 'RESTOCK'`,
      '"canonicalRequestHash" TEXT NOT NULL',
      '"submittedCredentialId" TEXT NOT NULL',
      '"branchId" TEXT NOT NULL',
      '"branchName" TEXT',
      '"variantId" TEXT',
      '"supersedesDecisionId" TEXT',
      `"status" "HumanDecisionStatus" NOT NULL DEFAULT 'PENDING'`,
      '"version" INTEGER NOT NULL DEFAULT 1',
      '"resolvedByActorId" TEXT',
      '"resolvedByDisplayName" TEXT',
      '"applicationEvidenceCode" TEXT',
      '"applicationAttemptedAt" TIMESTAMP(3)',
      '"ackReceivedAt" TIMESTAMP(3)',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" TIMESTAMP(3) NOT NULL',
    ]);
  });

  it('migration creates the two unique indexes and the ordering index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "human_decisions_tenantId_source_sourceRequestId_key"\s+ON "human_decisions"\("tenantId", "source", "sourceRequestId"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "human_decisions_tenantId_source_supersedesDecisionId_key"\s+ON "human_decisions"\("tenantId", "source", "supersedesDecisionId"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "human_decisions_tenantId_status_createdAt_id_idx"\s+ON "human_decisions"\("tenantId", "status", "createdAt", "id"\)/,
    );
  });

  it('migration FKs match the schema delete/update behavior', () => {
    expectAll(ddl, [
      'CONSTRAINT "human_decisions_tenantId_fkey"',
      'CONSTRAINT "human_decisions_resolvedById_fkey"',
    ]);
    expect(sql).toMatch(
      /FOREIGN KEY \("tenantId"\)\s+REFERENCES "tenants"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("resolvedById"\)\s+REFERENCES "users"\("id"\)\s+ON DELETE SET NULL ON UPDATE CASCADE/,
    );
  });

  it('migration enforces the resolution coupling and the 1..365 day bound', () => {
    expectAll(ddl, [
      'CONSTRAINT "human_decisions_resolution_state"',
      'CONSTRAINT "human_decisions_restock_days_range"',
    ]);
    // Zero days, negative days and >365 are contract violations.
    expect(sql).toMatch(/"restockDays"\s*>\s*=\s*1/);
    expect(sql).toMatch(/"restockDays"\s*<\s*=\s*365/);
    // Positive action carries days; the no-ETA action must NOT.
    expect(sql).toMatch(
      /"resolutionAction" = 'PROVIDE_RESTOCK_ESTIMATE' AND "restockDays" IS NOT NULL/,
    );
    expect(sql).toMatch(
      /"resolutionAction" = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' AND "restockDays" IS NULL/,
    );
    // Version is the CAS token: 1 while PENDING, exactly 2 once RESOLVED.
    expect(sql).toMatch(/"status" = 'PENDING'[\s\S]{0,200}?"version" = 1/);
    expect(sql).toMatch(/"status" = 'RESOLVED'[\s\S]{0,200}?"version" = 2/);
  });

  it('pins immutable reviewer snapshots with a SET NULL FK and the DB resolution CHECK', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(/^\s*resolvedById\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*resolvedByActorId\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*resolvedByDisplayName\s+String\?\s*$/m);
    // The live FK may null out when a User is deleted, so the durable
    // `{resolvedBy:{id,displayName}}` projection must read the snapshots.
    expect(decision).toMatch(
      /resolvedBy\s+User\?\s+@relation\(\s*"HumanDecisionResolver",\s*fields:\s*\[resolvedById\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("resolvedById"\)\s+REFERENCES "users"\("id"\)\s+ON DELETE SET NULL ON UPDATE CASCADE/,
    );

    const resolutionCheck = flat(
      checkBody(sql, 'human_decisions_resolution_state'),
    );
    expect(resolutionCheck).not.toBe('');
    // PENDING: both snapshots are NULL.
    expect(resolutionCheck).toMatch(
      /"status" = 'PENDING'[\s\S]*?"resolvedByActorId" IS NULL[\s\S]*?"resolvedByDisplayName" IS NULL/,
    );
    // RESOLVED: both snapshots are required.
    expect(resolutionCheck).toMatch(
      /"status" = 'RESOLVED'[\s\S]*?"resolvedByActorId" IS NOT NULL[\s\S]*?"resolvedByDisplayName" IS NOT NULL/,
    );
    // The FK column itself must remain nullable after User deletion; requiring
    // `resolvedById NOT NULL` here would make ON DELETE SET NULL unsatisfiable.
    expect(resolutionCheck).not.toContain('"resolvedById" IS NOT NULL');
  });

  it('pins the DB outcome/evidence consistency CHECK and its temporal branches', () => {
    const outcomeCheck = flat(
      checkBody(sql, 'human_decisions_application_outcome_state'),
    );
    expect(outcomeCheck).not.toBe('');

    // Pre-ACK: PENDING_DELIVERY is derived from NULL, and no ACK receipt can
    // exist without a terminal outcome.
    expect(outcomeCheck).toMatch(
      /"applicationOutcome" IS NULL[\s\S]*?"ackReceivedAt" IS NULL/,
    );
    for (const column of [
      'applicationAttemptId',
      'applicationEvidenceHash',
      'applicationEvidenceCode',
      'providerMessageId',
      'providerAcceptedObservedAt',
      'applicationAttemptedAt',
      'ackReceivedAt',
    ]) {
      expect(outcomeCheck).toMatch(new RegExp(`"${column}" IS NULL`));
    }

    // Any terminal outcome is the application of a RESOLVED human decision, and
    // `resolvedAt` is asserted non-null so the temporal comparisons below are
    // 2-valued (a UNKNOWN CHECK result would silently pass).
    expect(outcomeCheck).toMatch(
      /"applicationOutcome" IS NOT NULL[\s\S]*?"status" = 'RESOLVED'/,
    );
    expect(outcomeCheck).toContain('"resolvedAt" IS NOT NULL');
    expect(outcomeCheck).toContain('"applicationAttemptId" IS NOT NULL');
    expect(outcomeCheck).toContain('"applicationEvidenceHash" IS NOT NULL');
    expect(outcomeCheck).toContain('"ackReceivedAt" IS NOT NULL');

    // Branch-level pins: slice each clause from the flat body between outcome
    // markers, so a missing bound cannot be masked by a neighbouring branch.
    const branch = (startMarker: string, endMarker: string | null): string => {
      const start = outcomeCheck.indexOf(startMarker);
      if (start < 0) return '';
      const end =
        endMarker === null
          ? outcomeCheck.length
          : outcomeCheck.indexOf(endMarker);
      return end > start ? outcomeCheck.slice(start, end) : '';
    };
    const onTime = branch(
      `"applicationOutcome" = 'PROVIDER_ACCEPTED'`,
      `"applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'`,
    );
    const late = branch(
      `"applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'`,
      `"applicationOutcome" = 'DELIVERY_UNKNOWN'`,
    );
    const unknown = branch(
      `"applicationOutcome" = 'DELIVERY_UNKNOWN'`,
      `"applicationOutcome" = 'STALE'`,
    );
    const stale = branch(`"applicationOutcome" = 'STALE'`, null);
    for (const clause of [onTime, late, unknown, stale]) {
      expect(clause).not.toBe('');
    }

    // Every attempted send started inside the half-open window
    // [resolvedAt, resolvedAt + 1 hour).
    for (const attempted of [onTime, late, unknown]) {
      expect(attempted).toContain('"applicationAttemptedAt" IS NOT NULL');
      expect(attempted).toContain('"applicationAttemptedAt" >= "resolvedAt"');
      expect(attempted).toContain(
        `"applicationAttemptedAt" < "resolvedAt" + INTERVAL '1 hour'`,
      );
    }

    // On-time acceptance: provider id + bot-observed acceptance inside the
    // half-open window. Bot-reported facts, never device-delivery proof.
    expect(onTime).toContain('"providerMessageId" IS NOT NULL');
    expect(onTime).toContain('"providerAcceptedObservedAt" IS NOT NULL');
    expect(onTime).toContain('"providerAcceptedObservedAt" >= "resolvedAt"');
    expect(onTime).toContain(
      `"providerAcceptedObservedAt" < "resolvedAt" + INTERVAL '1 hour'`,
    );

    // Late acceptance: provider id + observation at/after resolvedAt + 1 hour.
    expect(late).toContain('"providerMessageId" IS NOT NULL');
    expect(late).toContain('"providerAcceptedObservedAt" IS NOT NULL');
    expect(late).toContain(
      `"providerAcceptedObservedAt" >= "resolvedAt" + INTERVAL '1 hour'`,
    );

    // UNKNOWN may retain a partial provider id as audit evidence, but must
    // never carry a definite acceptance timestamp (that would imply success).
    expect(unknown).toContain('"providerAcceptedObservedAt" IS NULL');
    expect(unknown).not.toContain('"providerMessageId" IS NULL');

    // STALE means no send could have occurred: no attempt, no provider evidence.
    expect(stale).toContain('"applicationAttemptedAt" IS NULL');
    expect(stale).toContain('"providerMessageId" IS NULL');
    expect(stale).toContain('"providerAcceptedObservedAt" IS NULL');

    // `resolvedById` stays out of this CHECK as well: SET NULL, not evidence.
    expect(outcomeCheck).not.toContain('"resolvedById"');
  });

  it('migration is additive-only and never touches stock/sale tables', () => {
    // The only ALTER TABLE target is the new table; no existing table is
    // rewritten, so no destructive alteration can hide behind a generic verb.
    const alteredTables = [...ddl.matchAll(/ALTER\s+TABLE\s+"([^"]+)"/gi)].map(
      (match) => match[1],
    );
    expect(new Set(alteredTables)).toEqual(new Set(['human_decisions']));
    expect(ddl).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT|INDEX|TABLE|TYPE)/i);
    expect(ddl).not.toMatch(
      /(ALTER|DROP|UPDATE|DELETE)\s+"?(products|variants|sales|sale_items|lots|stock_alert_states)/i,
    );
    expect(ddl).not.toMatch(/INSERT\s+INTO/i);
    // No row rewrite at all: this migration is schema-only, and "ON UPDATE
    // CASCADE" (no quote after UPDATE) must not be confused with a UPDATE DML.
    expect(ddl).not.toMatch(/\bUPDATE\s+"/i);
    expect(ddl).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Human resolution is not stock mutation and not a sale: no new statement
    // creates or rewrites a stock/sale table. The snapshot columns named
    // `observedStockAtRequest`/`stockObservedAt` are data, not mutation.
    expect(ddl).not.toMatch(
      /CREATE\s+TABLE\s+"(products|variants|lots|sales|sale_items|stock_alert_states)"/i,
    );
  });

  it('migration documents the exact manual rollback objects', () => {
    expect(sql).toMatch(/Rollback/i);
    expectAll(sql, [
      'human_decisions',
      'human_decisions_tenantId_source_sourceRequestId_key',
      'human_decisions_tenantId_source_supersedesDecisionId_key',
      'human_decisions_resolution_state',
      'human_decisions_application_outcome_state',
      'human_decisions_restock_days_range',
      'HumanDecisionBotOutcome',
    ]);
  });
});

/**
 * HD-EXP-01 — schema + migration drift guard for EXPIRATION human decisions.
 *
 * DB-free (fs only). EXPIRATION reuses `human_decisions` and adds five nullable
 * columns; nothing existing is dropped or rewritten. The change is split across
 * two migration files on purpose: `ALTER TYPE ... ADD VALUE` must COMMIT before
 * a later statement can reference the new enum member, because a value added
 * inside a transaction cannot be used again within that same transaction. The
 * persistence migration therefore lives in its own file (SQL transaction
 * block, opened by explicit BEGIN; and closed by COMMIT; — NOT a Git boundary).
 *
 * The RESTOCK `20260925000100` migration is pinned byte-identical below: this
 * change is additive and must never rewrite existing RESTOCK truth.
 */
describe('human-decisions EXPIRATION schema + migration drift guard (HD-EXP-01)', () => {
  const repoPath = (...segments: string[]): string =>
    path.join(process.cwd(), ...segments);
  const readIfPresent = (file: string): string =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const schemaText = fs.readFileSync(
    repoPath('prisma', 'schema.prisma'),
    'utf8',
  );
  const enumMigrationFile = repoPath(
    'prisma',
    'migrations',
    '20260929000100_human_decisions_expiration_enums',
    'migration.sql',
  );
  const persistenceMigrationFile = repoPath(
    'prisma',
    'migrations',
    '20260929000200_human_decisions_expiration_persistence',
    'migration.sql',
  );
  const legacyMigrationFile = repoPath(
    'prisma',
    'migrations',
    '20260925000100_human_decisions_restock',
    'migration.sql',
  );

  // Missing files yield '' so every assertion below fails usefully.
  const enumSql = readIfPresent(enumMigrationFile);
  const persistenceSql = readIfPresent(persistenceMigrationFile);
  // DDL only: header comments document the rollback and name DROP verbs.
  const persistenceDdl = persistenceSql.replace(/^\s*--.*$/gm, '');
  // Explicit commits release staging locks before scans, then scans before swaps.
  const phases = persistenceDdl.match(/BEGIN;[\s\S]*?COMMIT;/g) ?? [];
  const [stagingDdl = '', validateDdl = '', swapDdl = ''] = phases;
  const validateSql = validateDdl;
  const swapSql = swapDdl;

  const enumMembers = (name: string): string[] =>
    (
      schemaText.match(
        new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
      )?.[1] ?? ''
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

  const model = (name: string): string =>
    schemaText.match(
      new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'),
    )?.[1] ?? '';

  const flat = (fragment: string): string =>
    fragment.replace(/\s+/g, ' ').trim();

  // Body of `ADD CONSTRAINT "<name>"` up to its terminating `;`. CHECK bodies
  // hold no semicolon, so `NOT VALID` bodies are captured whole.
  const constraintBody = (source: string, name: string): string => {
    const start = source.indexOf(`ADD CONSTRAINT "${name}"`);
    if (start < 0) return '';
    return source.slice(start, source.indexOf(';', start));
  };

  const branch = (
    body: string,
    startMarker: string,
    endMarker: string | null,
  ): string => {
    const start = body.indexOf(startMarker);
    if (start < 0) return '';
    const end =
      endMarker === null ? body.length : body.indexOf(endMarker, start + 1);
    return end > start ? body.slice(start, end) : '';
  };

  const addColumns = (): string[] =>
    [...persistenceDdl.matchAll(/ADD COLUMN "([^"]+)"/g)].map(
      (match) => match[1],
    );

  it('appends the EXPIRATION members after the existing ones, in stable order', () => {
    expect(enumMembers('HumanDecisionType')).toEqual(['RESTOCK', 'EXPIRATION']);
    expect(enumMembers('HumanDecisionResolutionAction')).toEqual([
      'PROVIDE_RESTOCK_ESTIMATE',
      'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      'PROVIDE_EXPIRATION_TEXT',
      'REPORT_EXPIRATION_UNAVAILABLE',
    ]);
    // Status/outcome enums are untouched by this change.
    expect(enumMembers('HumanDecisionStatus')).toEqual(['PENDING', 'RESOLVED']);
    expect(enumMembers('HumanDecisionBotOutcome')).toEqual([
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'DELIVERY_UNKNOWN',
      'STALE',
    ]);
  });

  it('ships the enums in an explicit BEGIN/COMMIT migration, committed before persistence uses them', () => {
    expect(fs.existsSync(enumMigrationFile)).toBe(true);
    expect(enumSql).toMatch(
      /ALTER TYPE "HumanDecisionType" ADD VALUE 'EXPIRATION'/,
    );
    expect(enumSql).toMatch(
      /ALTER TYPE "HumanDecisionResolutionAction" ADD VALUE 'PROVIDE_EXPIRATION_TEXT'/,
    );
    expect(enumSql).toMatch(
      /ALTER TYPE "HumanDecisionResolutionAction" ADD VALUE 'REPORT_EXPIRATION_UNAVAILABLE'/,
    );
    // Enum-only file: no statement here may reference an uncommitted value.
    const enumDdl = enumSql.replace(/^\s*--.*$/gm, '');
    expect(enumDdl).not.toMatch(
      /ALTER\s+TABLE|CREATE\s+TABLE|ADD\s+COLUMN|CHECK/i,
    );

    // Persistence is a distinct file that uses the new values but never
    // re-declares the enum type.
    expect(fs.existsSync(persistenceMigrationFile)).toBe(true);
    expect(persistenceSql).toContain(`'EXPIRATION'`);
    expect(persistenceSql).not.toMatch(/ALTER\s+TYPE/);
    expect(enumDdl).toMatch(/^BEGIN;[\s\S]*COMMIT;$/m);
    expect(enumDdl.match(/^(BEGIN|COMMIT);$/gm)).toHaveLength(2);
  });

  it('declares the five nullable columns on the Prisma model', () => {
    const decision = model('HumanDecision');
    expect(decision).toMatch(/^\s*productUnit\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*variantName\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*variantOption\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*variantValue\s+String\?\s*$/m);
    expect(decision).toMatch(/^\s*expirationText\s+String\?\s*$/m);
  });

  it('adds exactly those five TEXT columns and no bytes/VARCHAR', () => {
    expect(addColumns()).toEqual([
      'productUnit',
      'variantName',
      'variantOption',
      'variantValue',
      'expirationText',
    ]);
    for (const column of addColumns()) {
      expect(persistenceDdl).toMatch(
        new RegExp(`ADD COLUMN "${column}" TEXT(;|\\s)`),
      );
    }
    expect(persistenceDdl).not.toMatch(
      /ADD COLUMN "[^"]+" (VARCHAR|BYTEA|CHARACTER VARYING)/i,
    );
  });

  it('pins the type-aware snapshot shape (RESTOCK null vs EXPIRATION required)', () => {
    const snapshot = flat(
      constraintBody(persistenceSql, 'human_decisions_snapshot_state'),
    );
    expect(snapshot).not.toBe('');

    const restock = branch(
      snapshot,
      `"type" = 'RESTOCK'`,
      `"type" = 'EXPIRATION'`,
    );
    expect(restock).not.toBe('');
    for (const column of [
      'productUnit',
      'variantName',
      'variantOption',
      'variantValue',
    ]) {
      expect(restock).toContain(`"${column}" IS NULL`);
    }

    const expiration = branch(snapshot, `"type" = 'EXPIRATION'`, null);
    expect(expiration).toContain('"productUnit" IS NOT NULL');
    // RESTOCK-only snapshot columns are forbidden for an EXPIRATION decision.
    for (const column of [
      'sku',
      'requestedQuantity',
      'observedStockAtRequest',
      'stockObservedAt',
      'supersedesDecisionId',
    ]) {
      expect(expiration).toContain(`"${column}" IS NULL`);
    }
    // Simple variant: all four NULL. Present variantId: only variantId is
    // required; name/option/value stay nullable.
    expect(expiration).toMatch(
      /"variantId" IS NULL[\s\S]*?"variantName" IS NULL[\s\S]*?"variantOption" IS NULL[\s\S]*?"variantValue" IS NULL/,
    );
    expect(expiration).toContain('OR "variantId" IS NOT NULL');
    expect(expiration).not.toMatch(/"variant(Name|Option|Value)" IS NOT NULL/);
  });

  it('stages the new snapshot constraint as NOT VALID then validates it', () => {
    expect(persistenceSql).toMatch(
      /ADD CONSTRAINT "human_decisions_snapshot_state"[\s\S]*?NOT VALID/,
    );
    expect(validateSql).toMatch(
      /VALIDATE CONSTRAINT "human_decisions_snapshot_state"/,
    );
  });

  it('swaps human_decisions_resolution_state with the type-aware v2 body', () => {
    expect(persistenceSql).toMatch(
      /ADD CONSTRAINT "human_decisions_resolution_state_v2"/,
    );
    expect(validateSql).toMatch(
      /VALIDATE CONSTRAINT "human_decisions_resolution_state_v2"/,
    );
    expect(swapSql).toMatch(
      /DROP CONSTRAINT "human_decisions_resolution_state"/,
    );
    expect(swapSql).toMatch(
      /RENAME CONSTRAINT "human_decisions_resolution_state_v2" TO "human_decisions_resolution_state"/,
    );

    const check = flat(
      constraintBody(persistenceSql, 'human_decisions_resolution_state_v2'),
    );
    expect(check).not.toBe('');

    // PENDING v1: every resolution field NULL, now including expirationText.
    const pending = branch(
      check,
      `"status" = 'PENDING'`,
      `"status" = 'RESOLVED'`,
    );
    expect(pending).not.toBe('');
    expect(pending).toContain('"version" = 1');
    for (const column of [
      'resolutionAction',
      'restockDays',
      'expirationText',
      'resolutionRequestId',
      'resolvedAt',
      'resolvedByActorId',
      'resolvedByDisplayName',
    ]) {
      expect(pending).toContain(`"${column}" IS NULL`);
    }

    // RESOLVED v2 keeps the current audit requirements.
    const resolved = branch(check, `"status" = 'RESOLVED'`, null);
    expect(resolved).toContain('"version" = 2');
    for (const column of [
      'resolutionAction',
      'resolutionRequestId',
      'resolvedAt',
      'resolvedByActorId',
      'resolvedByDisplayName',
    ]) {
      expect(resolved).toContain(`"${column}" IS NOT NULL`);
    }

    // RESTOCK truth preserved verbatim; expirationText stays NULL.
    expect(resolved).toContain(
      `"resolutionAction" = 'PROVIDE_RESTOCK_ESTIMATE' AND "restockDays" IS NOT NULL`,
    );
    expect(resolved).toContain(
      `"resolutionAction" = 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' AND "restockDays" IS NULL`,
    );
    // EXPIRATION truth: text OR unavailable; restockDays stays NULL either way.
    expect(resolved).toContain(
      `"resolutionAction" = 'PROVIDE_EXPIRATION_TEXT' AND "expirationText" IS NOT NULL`,
    );
    expect(resolved).toContain(
      `"resolutionAction" = 'REPORT_EXPIRATION_UNAVAILABLE' AND "expirationText" IS NULL`,
    );
    // Action ownership is discriminated by explicit type branches.
    expect(resolved).toContain(`"type" = 'RESTOCK'`);
    expect(resolved).toContain(`"type" = 'EXPIRATION'`);
  });

  it('swaps human_decisions_application_outcome_state with the shared type-aware deadline', () => {
    expect(persistenceSql).toMatch(
      /ADD CONSTRAINT "human_decisions_application_outcome_state_v2"/,
    );
    expect(validateSql).toMatch(
      /VALIDATE CONSTRAINT "human_decisions_application_outcome_state_v2"/,
    );
    expect(swapSql).toMatch(
      /DROP CONSTRAINT "human_decisions_application_outcome_state"/,
    );
    expect(swapSql).toMatch(
      /RENAME CONSTRAINT "human_decisions_application_outcome_state_v2" TO "human_decisions_application_outcome_state"/,
    );

    const check = flat(
      constraintBody(
        persistenceSql,
        'human_decisions_application_outcome_state_v2',
      ),
    );
    expect(check).not.toBe('');

    // The four terminal outcomes and the CAS/evidence shape are unchanged.
    for (const outcome of [
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'DELIVERY_UNKNOWN',
      'STALE',
    ]) {
      expect(check).toContain(`"applicationOutcome" = '${outcome}'`);
    }
    expect(check).toContain(`"status" = 'RESOLVED'`);
    for (const column of [
      'resolvedAt',
      'applicationAttemptId',
      'applicationEvidenceHash',
      'ackReceivedAt',
    ]) {
      expect(check).toContain(`"${column}" IS NOT NULL`);
    }

    // Single shared deadline expression, discriminated by type: 1h vs 24h.
    expect(check).toContain(
      `CASE "type" WHEN 'RESTOCK' THEN INTERVAL '1 hour' WHEN 'EXPIRATION' THEN INTERVAL '24 hours' END`,
    );
    // Explicit supported-type guard keeps the CASE two-valued (fail closed for
    // an unsupported type instead of yielding UNKNOWN and passing).
    expect(check).toContain(`"type" IN ('RESTOCK', 'EXPIRATION')`);

    const onTime = branch(
      check,
      `"applicationOutcome" = 'PROVIDER_ACCEPTED'`,
      `"applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'`,
    );
    const late = branch(
      check,
      `"applicationOutcome" = 'PROVIDER_ACCEPTED_LATE'`,
      `"applicationOutcome" = 'DELIVERY_UNKNOWN'`,
    );
    const unknown = branch(
      check,
      `"applicationOutcome" = 'DELIVERY_UNKNOWN'`,
      `"applicationOutcome" = 'STALE'`,
    );
    const stale = branch(check, `"applicationOutcome" = 'STALE'`, null);
    for (const clause of [onTime, late, unknown, stale]) {
      expect(clause).not.toBe('');
    }

    // Every attempted send is in the half-open window [resolvedAt, deadline).
    for (const attempted of [onTime, late, unknown]) {
      expect(attempted).toContain('"applicationAttemptedAt" IS NOT NULL');
      expect(attempted).toContain('"applicationAttemptedAt" >= "resolvedAt"');
      expect(attempted).toContain(
        '"applicationAttemptedAt" < "resolvedAt" + (CASE',
      );
    }

    // On-time acceptance is strictly inside the deadline; LATE is at/after it.
    expect(onTime).toContain('"providerAcceptedObservedAt" IS NOT NULL');
    expect(onTime).toContain('"providerAcceptedObservedAt" >= "resolvedAt"');
    expect(onTime).toContain(
      '"providerAcceptedObservedAt" < "resolvedAt" + (CASE',
    );
    expect(late).toContain('"providerAcceptedObservedAt" IS NOT NULL');
    expect(late).toContain(
      '"providerAcceptedObservedAt" >= "resolvedAt" + (CASE',
    );
    expect(late).not.toContain('"providerAcceptedObservedAt" < "resolvedAt"');

    // UNKNOWN carries no acceptance evidence; STALE could not have sent.
    expect(unknown).toContain('"providerAcceptedObservedAt" IS NULL');
    expect(stale).toContain('"applicationAttemptedAt" IS NULL');

    // ackReceivedAt keeps presence-only semantics: no extra deadline bound.
    expect(check).not.toMatch(/"ackReceivedAt"\s*[<>]/);
  });

  it('leaves the 20260925000100 RESTOCK migration byte-identical', () => {
    const legacy = fs.readFileSync(legacyMigrationFile, 'utf8');
    expect(createHash('sha256').update(legacy, 'utf8').digest('hex')).toBe(
      '515cd9b46241a18e554f27f141abdf1f6e8579e346d1f61fe6fcbc847c7cf283',
    );
    expect(legacy).toContain(
      `ADD CONSTRAINT "human_decisions_resolution_state"`,
    );
  });

  it('is additive-only: no new tables, indexes, foreign keys or backfill', () => {
    expect(persistenceDdl).not.toMatch(/CREATE\s+TABLE/i);
    expect(persistenceDdl).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(persistenceDdl).not.toMatch(/FOREIGN KEY|REFERENCES\s+"/i);
    expect(persistenceDdl).not.toMatch(
      /INSERT\s+INTO|\bUPDATE\s+"|\bDELETE\s+FROM/i,
    );
    expect(persistenceDdl).not.toMatch(/DROP\s+(TABLE|TYPE|INDEX|COLUMN)/i);
    // No catalog/snapshot FK: the snapshot is stored data, not a relation.
    expect(persistenceDdl).not.toMatch(/products|variants/i);
    // The only ALTER TABLE target is the reused human_decisions table.
    const alteredTables = [
      ...persistenceDdl.matchAll(/ALTER\s+TABLE\s+"([^"]+)"/gi),
    ].map((match) => match[1]);
    expect(new Set(alteredTables)).toEqual(new Set(['human_decisions']));
  });

  it('runs staging, validation and swap as three phased transactions', () => {
    expect(phases).toHaveLength(3);
    expect(persistenceDdl.replace(/BEGIN;[\s\S]*?COMMIT;/g, '').trim()).toBe(
      '',
    );
    for (const ddl of phases) {
      expect(ddl).toMatch(/^BEGIN;[\s\S]*COMMIT;$/m);
      expect(ddl.match(/^(BEGIN|COMMIT);$/gm)).toHaveLength(2);
    }
    expect(stagingDdl.match(/ADD COLUMN /g)).toHaveLength(5);
    expect(stagingDdl.match(/NOT VALID/g)).toHaveLength(3);
    expect(stagingDdl).not.toMatch(
      /VALIDATE CONSTRAINT|DROP CONSTRAINT|RENAME CONSTRAINT/,
    );
    expect(validateDdl).not.toMatch(
      /ADD COLUMN|ADD CONSTRAINT|DROP CONSTRAINT|RENAME CONSTRAINT/,
    );
    expect(swapDdl).not.toMatch(
      /ADD COLUMN|ADD CONSTRAINT|VALIDATE CONSTRAINT/,
    );
  });

  it('stages NOT VALID checks then validates and swaps them', () => {
    expect(persistenceDdl.match(/NOT VALID/g)).toHaveLength(3);
    expect(validateDdl.match(/VALIDATE CONSTRAINT /g)).toHaveLength(3);
    for (const old of [
      'human_decisions_resolution_state',
      'human_decisions_application_outcome_state',
    ]) {
      expect(swapDdl).toContain(`DROP CONSTRAINT "${old}"`);
      expect(swapDdl).toContain(`RENAME CONSTRAINT "${old}_v2" TO "${old}"`);
      expect(`${stagingDdl}${validateDdl}`).not.toContain(
        `DROP CONSTRAINT "${old}"`,
      );
    }
    expect(swapDdl.match(/DROP CONSTRAINT /g)).toHaveLength(2);
    expect(swapDdl.match(/RENAME CONSTRAINT /g)).toHaveLength(2);
  });
});
