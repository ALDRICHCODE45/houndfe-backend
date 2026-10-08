/**
 * cash-register-closing / S10 — read projections and history (S3, S4, S7).
 *
 * Every query kind requires an active user AND tenant membership (checked by
 * the facade before dispatch). Base/audit visibility is evaluated PER ROW
 * against a tagged instance BEFORE pagination and counting, so a conditional
 * rule can never widen the total or leak an inaccessible row. A declarant's
 * own pre-submission projection never carries expected values or movements.
 */
import { Prisma } from '@prisma/client';
import type { CashCount } from '@prisma/client';
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
import { normalizePage, parseRange } from './cash-adapter-paging';
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
    session: projection,
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
  if (query.page.cashierUserId !== undefined) {
    where.cashierUserId = query.page.cashierUserId;
  }
  if (query.page.registerId !== undefined) {
    where.registerId = query.page.registerId;
  }
  if (query.pendingOnly === true) {
    where.status = { in: ['COUNTING', 'SUBMITTED'] };
  }
  if (range.from || range.to) {
    where.openedAt = {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    };
  }
  const rows = await tx.cashSession.findMany({
    where,
    orderBy: { openedAt: 'desc' },
  });
  // S3 — evaluate base/audit visibility PER ROW (tagged instance) BEFORE
  // pagination and counting, so a conditional audit or base rule can never
  // widen the total or leak an inaccessible row.
  const visible = rows.filter((row) => isSessionVisible(actor, row));
  const total = visible.length;
  const pageRows = visible.slice(skip, skip + limit);
  const ids = pageRows.map((row) => row.id);
  const movementsBySession = await movementsForSessions(tx, tenantId, ids);
  const countsBySession = await countsForSessions(tx, tenantId, ids);
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
    return projectCashSession({
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
  if (input.registerId !== undefined) {
    const sessionIds = (
      await tx.cashSession.findMany({
        where: { tenantId, registerId: input.registerId },
      })
    ).map((row) => row.id);
    where.sessionId = { in: sessionIds };
  }
  if (range.from || range.to) {
    where.createdAt = {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    };
  }
  const rows = await tx.cashClosing.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
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
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const visible = rows.filter((row) =>
    isClosingVisible(actor, row, sessionById.get(row.sessionId) ?? null),
  );
  const total = visible.length;
  const items = visible.slice(skip, skip + limit).map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    folio: row.folio,
    createdAt: iso(row.createdAt),
  }));
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
  return closingDocument(row, decodeClosingSnapshot(row.snapshotJson));
}

// ── Shared query helpers ────────────────────────────────────────────

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
