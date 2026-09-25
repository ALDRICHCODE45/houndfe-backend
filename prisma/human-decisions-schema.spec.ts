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
    expect(enumMembers('HumanDecisionType')).toEqual(['RESTOCK']);
    expect(enumMembers('HumanDecisionStatus')).toEqual(['PENDING', 'RESOLVED']);
    expect(enumMembers('HumanDecisionResolutionAction')).toEqual([
      'PROVIDE_RESTOCK_ESTIMATE',
      'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
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
