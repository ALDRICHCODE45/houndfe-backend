/**
 * cash-register-closing / S10 — read projections and history (S3, S4, S7).
 *
 * Every query kind requires an active user AND tenant membership (checked by
 * the facade before dispatch). Base/audit visibility is evaluated PER ROW
 * against a tagged instance BEFORE pagination and counting, so a conditional
 * rule can never widen the total or leak an inaccessible row. A declarant's
 * own pre-submission projection never carries expected values or movements.
 *
 * cash-redesign-reads S5: when every relevant grant is unconditional (see
 * `cash-adapter-list-scope.ts`) the same visibility is a DB clause, so the
 * session and closing lists page (`skip`/`take`) and count in PostgreSQL;
 * conditional grants keep the per-row path above.
 */
import { Prisma } from '@prisma/client';
import type { CashClosing, CashCount, CashSession } from '@prisma/client';
import { expectedCashCents, projectCashSession } from '../domain';
import {
  CASH_AUDIT_REQUIREMENT,
  CASH_CLOSING_READ_REQUIREMENT,
  CASH_REGISTER_READ_REQUIREMENT,
  CASH_SESSION_READ_REQUIREMENT,
  assertAbility,
  canInstanceAbility,
} from '../application/cash-authorization';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashDocument,
  CashJson,
  CashQuery,
} from '../cash-application.port';
import { decodeClosingSnapshot, decodeExpectedSnapshot } from './cash-json';
import type { TenantClient } from './cash-adapter-client';
import { cashCents, latestDeclaration } from './cash-adapter-count-rules';
import {
  closingInstance,
  isClosingVisible,
  isSessionVisible,
  registerInstance,
  sessionInstance,
} from './cash-adapter-instances';
import {
  closingDocument,
  countDocument,
  handoverDocument,
  movementDocument,
  toDomainMovement,
  toDomainSession,
} from './cash-adapter-mappers';
import { closingListItems } from './cash-adapter-closing-list';
import { resolveListScope } from './cash-adapter-list-scope';
import { normalizePage, parseRange } from './cash-adapter-paging';
import { userNames } from './cash-adapter-storage';
import { document, iso } from './cash-adapter-values';

export async function queryRegisters(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
): Promise<CashDocument> {
  assertAbility(actor, {
    action: 'read',
    subject: 'CashRegister',
  });
  const rows = await tx.cashRegister.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
  });
  // S3 — base reads are condition-checked PER ROW: a conditional
  // `read:CashRegister` excludes non-matching registers instead of
  // returning every tenant register.
  const visible = rows.filter((row) =>
    canInstanceAbility(
      actor,
      CASH_REGISTER_READ_REQUIREMENT,
      registerInstance(row),
    ),
  );
  return document({
    items: visible.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      createdAt: iso(row.createdAt),
    })),
  });
}

export async function querySession(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  sessionId: string,
): Promise<CashDocument> {
  assertAbility(actor, CASH_SESSION_READ_REQUIREMENT);
  const row = await tx.cashSession.findFirst({
    where: { tenantId, id: sessionId },
  });
  if (!row) {
    throw cashAppError(
      CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
      'Cash session not found',
      { sessionId },
    );
  }
  const instance = sessionInstance(row);
  const isOwner = row.cashierUserId === actor.userId;
  // S3 — base session reads are condition-checked against the real row; a
  // non-owner (or a conditional base rule that excludes the row) must pass
  // the audit instance check instead of a string subject.
  const baseVisible =
    isOwner &&
    canInstanceAbility(actor, CASH_SESSION_READ_REQUIREMENT, instance);
  if (!baseVisible) {
    assertAbility(actor, CASH_AUDIT_REQUIREMENT, instance);
  }
  const auditVisible = canInstanceAbility(
    actor,
    CASH_AUDIT_REQUIREMENT,
    instance,
  );
  const movementRows = await tx.cashMovement.findMany({
    where: { tenantId, sessionId: row.id },
    orderBy: { occurredAt: 'asc' },
  });
  const movements = movementRows.map((movement) => toDomainMovement(movement));
  const counts = await tx.cashCount.findMany({
    where: { tenantId, sessionId: row.id },
    orderBy: { revision: 'asc' },
  });
  const handovers = await tx.cashHandover.findMany({
    where: { tenantId, sourceSessionId: row.id },
    orderBy: { createdAt: 'asc' },
  });
  const closing = await tx.cashClosing.findFirst({
    where: { tenantId, sessionId: row.id },
  });
  const declared = latestDeclaration(counts);
  const submitted = declared !== null;
  const expectedSnapshot = decodeExpectedSnapshot(row.expectedJson);
  const expectedCash = expectedSnapshot
    ? expectedSnapshot.cashExpectedCents
    : expectedCashCents({
        openingCents: row.openingCents,
        movements,
      });
  const projection = projectCashSession({
    session: toDomainSession(row),
    viewerUserId: actor.userId,
    expectedCashCents: expectedCash,
    declaredCents: declared ? cashCents(declared.lines) : null,
    hasAuditVisibility: auditVisible,
    declarationSubmitted: submitted,
  });
  const register = await tx.cashRegister.findFirst({
    where: { tenantId, id: row.registerId },
  });
  const names = await userNames(tx, [row.cashierUserId]);
  const blind = projection.blind === true;
  // S1 — additive blind discovery. A frozen COUNTING session owned by the
  // declarant hides `channelSnapshot`/`movements`, so the client cannot know
  // which channels the blind count must declare. Expose the IDENTITY list
  // only, derived from the FROZEN expected snapshot (never the current
  // payment catalog, so a later rename/removal cannot rewrite history) and
  // exactly the channels DECLARE accepts as `requiredChannelKeys` (always
  // including pooled CASH). No expected cents, differences, movement or
  // source metadata. Absent for the blind OPEN window (nothing frozen yet),
  // for a wider audit reader, and once expected values are revealed via
  // `channelSnapshot`.
  const requiredChannels =
    blind && expectedSnapshot
      ? expectedSnapshot.channels.map((channel) => ({
          channelKey: channel.channelKey,
          channelLabel: channel.channelLabel,
          method: channel.method,
        }))
      : null;
  return document({
    session: { ...projection, ...sessionDisplayFields(row, names) },
    register: register
      ? {
          id: register.id,
          name: register.name,
          isActive: register.isActive,
        }
      : null,
    movements: blind
      ? []
      : movementRows.map((movement) => movementDocument(movement)),
    counts: counts.map((count) => countDocument(count)),
    handovers: handovers.map((handover) => handoverDocument(handover)),
    closing: closing
      ? {
          id: closing.id,
          folio: closing.folio,
          createdAt: iso(closing.createdAt),
        }
      : null,
    channelSnapshot: blind
      ? null
      : expectedSnapshot
        ? expectedSnapshot.channels
        : null,
    ...(requiredChannels === null ? {} : { requiredChannels }),
  });
}

export async function querySessions(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  query: Extract<CashQuery, { kind: 'SESSIONS' }>,
): Promise<CashDocument> {
  assertAbility(actor, CASH_SESSION_READ_REQUIREMENT);
  const { page, limit, skip } = normalizePage(query.page);
  const range = parseRange(query.page.from, query.page.to);
  const where: Prisma.CashSessionWhereInput = { tenantId };
  // Every filter NARROWS: `pendingOnly` and `statuses` intersect, and both
  // combine with the drawer, cashier, register and date filters.
  const and: Prisma.CashSessionWhereInput[] = [];
  if (query.page.cashierUserId !== undefined) {
    where.cashierUserId = query.page.cashierUserId;
  }
  if (query.page.registerId !== undefined) {
    where.registerId = query.page.registerId;
  }
  if (query.pendingOnly === true) {
    and.push({ status: { in: ['COUNTING', 'SUBMITTED'] } });
  }
  if (query.statuses !== undefined) {
    and.push({ status: { in: [...query.statuses] } });
  }
  if (query.drawerOpen === true) {
    where.drawerReleasedAt = null;
  } else if (query.drawerOpen === false) {
    where.drawerReleasedAt = { not: null };
  }
  if (range.from || range.to) {
    where.openedAt = {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    };
  }
  if (and.length > 0) {
    where.AND = and;
  }
  // `id` breaks `openedAt` ties so DB pages are deterministic.
  const orderBy: Prisma.CashSessionOrderByWithRelationInput[] = [
    { openedAt: 'desc' },
    { id: 'desc' },
  ];
  let total: number;
  let pageRows: CashSession[];
  const scope = resolveListScope(
    actor,
    CASH_SESSION_READ_REQUIREMENT,
    CASH_AUDIT_REQUIREMENT,
  );
  if (scope === 'PER_ROW') {
    // S3 — conditional grants: evaluate base/audit visibility PER ROW
    // (tagged instance) BEFORE pagination and counting, so a conditional
    // audit or base rule can never widen the total or leak a row.
    const rows = await tx.cashSession.findMany({ where, orderBy });
    const visible = rows.filter((row) => isSessionVisible(actor, row));
    total = visible.length;
    pageRows = visible.slice(skip, skip + limit);
  } else if (scope === 'NONE') {
    total = 0;
    pageRows = [];
  } else {
    // S5 — unconditional grants: the same visibility as a DB clause, so
    // the count and the page come straight from PostgreSQL.
    const scoped: Prisma.CashSessionWhereInput =
      scope === 'OWN'
        ? { AND: [where, { cashierUserId: actor.userId }] }
        : where;
    total = await tx.cashSession.count({ where: scoped });
    pageRows = await tx.cashSession.findMany({
      where: scoped,
      orderBy,
      skip,
      take: limit,
    });
  }
  const ids = pageRows.map((row) => row.id);
  const movementsBySession = await movementsForSessions(tx, tenantId, ids);
  const countsBySession = await countsForSessions(tx, tenantId, ids);
  const names = await userNames(
    tx,
    pageRows.map((row) => row.cashierUserId),
  );
  const items = pageRows.map((row) => {
    const counts = countsBySession.get(row.id) ?? [];
    const declared = latestDeclaration(counts);
    const submitted = declared !== null;
    const movements = movementsBySession.get(row.id) ?? [];
    const expectedSnapshot = decodeExpectedSnapshot(row.expectedJson);
    const expectedCash = expectedSnapshot
      ? expectedSnapshot.cashExpectedCents
      : expectedCashCents({
          openingCents: row.openingCents,
          movements,
        });
    const projection = projectCashSession({
      session: toDomainSession(row),
      viewerUserId: actor.userId,
      expectedCashCents: expectedCash,
      declaredCents: declared ? cashCents(declared.lines) : null,
      hasAuditVisibility: canInstanceAbility(
        actor,
        CASH_AUDIT_REQUIREMENT,
        sessionInstance(row),
      ),
      declarationSubmitted: submitted,
    });
    return { ...projection, ...sessionDisplayFields(row, names) };
  });
  return document({ items, page, limit, total });
}

export async function queryClosings(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  input: {
    page?: number;
    limit?: number;
    registerId?: string;
    cashierUserId?: string;
    from?: string;
    to?: string;
  },
): Promise<CashDocument> {
  assertAbility(actor, CASH_CLOSING_READ_REQUIREMENT);
  const { page, limit, skip } = normalizePage({
    page: input.page,
    limit: input.limit,
  });
  const range = parseRange(input.from, input.to);
  const where: Prisma.CashClosingWhereInput = { tenantId };
  const and: Prisma.CashClosingWhereInput[] = [];
  // `registerId` and (cash-redesign-reads S4) `cashierUserId` describe the
  // CLOSED SESSION, so both narrow through the (tenant-scoped) session
  // relation instead of an id list that grows with history.
  if (input.registerId !== undefined || input.cashierUserId !== undefined) {
    and.push({
      session: {
        is: {
          ...(input.registerId !== undefined
            ? { registerId: input.registerId }
            : {}),
          ...(input.cashierUserId !== undefined
            ? { cashierUserId: input.cashierUserId }
            : {}),
        },
      },
    });
  }
  if (range.from || range.to) {
    where.createdAt = {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    };
  }
  const orderBy: Prisma.CashClosingOrderByWithRelationInput[] = [
    { createdAt: 'desc' },
    { id: 'desc' },
  ];
  const scope = resolveListScope(
    actor,
    CASH_CLOSING_READ_REQUIREMENT,
    CASH_AUDIT_REQUIREMENT,
  );
  let total: number;
  let pageRows: CashClosing[];
  // Sessions already loaded by the per-row path are reused by the item
  // projection, so neither path reads per row (cash-redesign-reads S7).
  let knownSessions: Map<string, CashSession> | undefined;
  if (scope === 'PER_ROW') {
    if (and.length > 0) {
      where.AND = and;
    }
    const rows = await tx.cashClosing.findMany({ where, orderBy });
    // S3 — per-row audit/base visibility BEFORE pagination and count. The
    // closing instance carries the source session's register/cashier so a
    // conditional audit rule is evaluated against real server-owned context.
    const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
    const sessions =
      sessionIds.length > 0
        ? await tx.cashSession.findMany({
            where: { tenantId, id: { in: sessionIds } },
          })
        : [];
    const sessionById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    const visible = rows.filter((row) =>
      isClosingVisible(actor, row, sessionById.get(row.sessionId) ?? null),
    );
    total = visible.length;
    pageRows = visible.slice(skip, skip + limit);
    knownSessions = sessionById;
  } else if (scope === 'NONE') {
    total = 0;
    pageRows = [];
  } else {
    // S5 — unconditional grants: OWN means closed by the actor OR of one of
    // the actor's sessions, exactly like `isClosingVisible`.
    if (scope === 'OWN') {
      and.push({
        OR: [
          { closedByUserId: actor.userId },
          { session: { is: { cashierUserId: actor.userId } } },
        ],
      });
    }
    if (and.length > 0) {
      where.AND = and;
    }
    total = await tx.cashClosing.count({ where });
    pageRows = await tx.cashClosing.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    });
  }
  const items = await closingListItems(tx, tenantId, pageRows, knownSessions);
  return document({ items, page, limit, total });
}

export async function queryClosing(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  closingId: string,
): Promise<CashDocument> {
  assertAbility(actor, CASH_CLOSING_READ_REQUIREMENT);
  const row = await tx.cashClosing.findFirst({
    where: { tenantId, id: closingId },
  });
  if (!row) {
    throw cashAppError(
      CASH_APPLICATION_CODES.CLOSING_NOT_FOUND,
      'Cash closing not found',
      { closingId },
    );
  }
  const session = await tx.cashSession.findFirst({
    where: { tenantId, id: row.sessionId },
  });
  if (!isClosingVisible(actor, row, session)) {
    assertAbility(actor, CASH_AUDIT_REQUIREMENT, closingInstance(row, session));
  }
  return closingDocument(
    row,
    await withReadTimeNames(tx, decodeClosingSnapshot(row.snapshotJson)),
  );
}

type ClosingSnapshotJson = ReturnType<typeof decodeClosingSnapshot>;

const HANDOVER_NAME_FIELDS = [
  ['senderUserId', 'senderName'],
  ['receiverUserId', 'receiverName'],
  ['receiptActorUserId', 'receiptActorName'],
] as const;

const SNAPSHOT_NAME_FIELDS = [
  ['cashierUserId', 'cashierName'],
  ['verifierUserId', 'verifierName'],
  ['closedByUserId', 'closedByName'],
] as const;

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Ids whose frozen display name is absent (snapshots frozen before T2). */
function missingNameIds(
  owner: Record<string, unknown>,
  fields: ReadonlyArray<readonly [string, string]>,
): string[] {
  return fields.flatMap(([idKey, nameKey]) =>
    hasText(owner[idKey]) && !hasText(owner[nameKey]) ? [owner[idKey]] : [],
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fillNames(
  owner: Record<string, CashJson>,
  fields: ReadonlyArray<readonly [string, string]>,
  names: ReadonlyMap<string, string>,
): Record<string, CashJson> {
  const filled: Record<string, CashJson> = { ...owner };
  for (const [idKey, nameKey] of fields) {
    const id = owner[idKey];
    const name = typeof id === 'string' ? names.get(id) : undefined;
    if (!hasText(owner[nameKey]) && name !== undefined) {
      filled[nameKey] = name;
    }
  }
  return filled;
}

/**
 * pdf-a4-redesign T2 (S1) — snapshots frozen before display names were
 * captured (handover sender/receiver/receipt actor, and older actor names)
 * get CURRENT names resolved at read time for display only; the stored row is
 * never rewritten and frozen names always win. The lookup is ONE batched
 * users query built exclusively from ids inside this tenant-scoped closing
 * row (the closing was already fetched by `tenantId`), and it is skipped
 * entirely when the snapshot already carries every name. An unresolvable id
 * stays nameless so the PDF prints «Usuario sin nombre», never the id.
 */
async function withReadTimeNames(
  tx: TenantClient,
  snapshot: ClosingSnapshotJson,
): Promise<ClosingSnapshotJson> {
  const handovers = Array.isArray(snapshot.handovers)
    ? snapshot.handovers
    : null;
  const ids = new Set<string>(missingNameIds(snapshot, SNAPSHOT_NAME_FIELDS));
  for (const handover of handovers ?? []) {
    const record = asRecord(handover);
    if (record !== null) {
      missingNameIds(record, HANDOVER_NAME_FIELDS).forEach((id) => ids.add(id));
    }
  }
  if (ids.size === 0) {
    return snapshot;
  }
  const names = await userNames(tx, [...ids]);
  const filled = fillNames(snapshot, SNAPSHOT_NAME_FIELDS, names);
  if (handovers !== null) {
    filled.handovers = handovers.map((handover) => {
      const record = asRecord(handover);
      return record === null
        ? handover
        : fillNames(
            record as Record<string, CashJson>,
            HANDOVER_NAME_FIELDS,
            names,
          );
    });
  }
  return filled;
}

// ── Shared query helpers ────────────────────────────────────────────

/**
 * fe-design-pass T1 (S1, S2) — additive display fields for session reads.
 * Lifecycle timestamps and the cashier's visible name carry no expected
 * values, so they are safe for a blind projection too. A missing user row
 * yields `cashierDisplayName: null`.
 */
function sessionDisplayFields(
  row: CashSession,
  names: ReadonlyMap<string, string>,
): {
  openedAt: string;
  closedAt: string | null;
  cashierDisplayName: string | null;
} {
  return {
    openedAt: row.openedAt.toISOString(),
    closedAt: iso(row.closedAt),
    cashierDisplayName: names.get(row.cashierUserId) ?? null,
  };
}

async function movementsForSessions(
  tx: TenantClient,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, ReturnType<typeof toDomainMovement>[]>> {
  const bySession = new Map<string, ReturnType<typeof toDomainMovement>[]>();
  if (sessionIds.length === 0) {
    return bySession;
  }
  const rows = await tx.cashMovement.findMany({
    where: { tenantId, sessionId: { in: [...sessionIds] } },
  });
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(toDomainMovement(row));
    bySession.set(row.sessionId, list);
  }
  return bySession;
}

async function countsForSessions(
  tx: TenantClient,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, CashCount[]>> {
  const bySession = new Map<string, CashCount[]>();
  if (sessionIds.length === 0) {
    return bySession;
  }
  const rows = await tx.cashCount.findMany({
    where: { tenantId, sessionId: { in: [...sessionIds] } },
    orderBy: { revision: 'asc' },
  });
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  return bySession;
}
