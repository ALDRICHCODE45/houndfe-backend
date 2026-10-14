/**
 * cash-register-closing / G2 — recipient custody discovery (S2, S4).
 *
 * A recipient needs to find the handovers owed to them and the FLOAT they have
 * already received WITHOUT a broad session-audit grant, and without being able
 * to widen scope through a body/query recipient id. This module therefore:
 *
 *   - requires the granular `read:CashHandover` ability and fails CLOSED when
 *     it is missing (a denial, never a silent successful empty page);
 *   - filters by the tenant AND the authenticated actor as recipient, then
 *     re-evaluates the CASL ability PER ROW against the tagged handover
 *     instance (recipient/sender/session/kind) BEFORE totals and pagination,
 *     so a conditional grant can never widen the total or leak a row;
 *   - reports only narrow custody identity/amounts/timestamps plus, for FLOAT,
 *     the source register id and drawer-release state needed to interpret the
 *     same-register release rule — never source-session expected totals,
 *     movements or channel snapshots.
 *
 * It is a read-only projection: it performs no writes and no reservation, and
 * it deliberately does NOT globally exclude received FLOAT whose source drawer
 * is still unreleased. Opening remains the authoritative check.
 */
import type { CashHandover, CashSession } from '@prisma/client';
import {
  resolveOpeningFundCents,
  type CashHandover as DomainCashHandover,
} from '../domain';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  CASH_HANDOVER_READ_REQUIREMENT,
  assertAbility,
  canInstanceAbility,
} from '../application/cash-authorization';
import type {
  CashActor,
  CashDocument,
  CashPageInput,
} from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import { handoverInstance } from './cash-adapter-instances';
import { normalizePage } from './cash-adapter-paging';
import { document, iso } from './cash-adapter-values';

export async function queryCustody(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  page: CashPageInput,
): Promise<CashDocument> {
  // Fail closed: the handover read is granular and audit visibility
  // (`read:CashSessionAudit`) is deliberately NOT a substitute.
  assertAbility(actor, CASH_HANDOVER_READ_REQUIREMENT);
  const {
    page: pageNumber,
    limit,
    skip,
  } = normalizePage({ page: page.page, limit: page.limit });

  // Tenant + authenticated recipient scope only; the recipient can never be
  // supplied by the caller.
  const pendingRows = await tx.cashHandover.findMany({
    where: {
      tenantId,
      recipientUserId: actor.userId,
      receivedAt: null,
      receivedByUserId: null,
    },
    orderBy: { createdAt: 'asc' },
  });
  const floatRows = await tx.cashHandover.findMany({
    where: {
      tenantId,
      recipientUserId: actor.userId,
      kind: 'FLOAT',
      receivedAt: { not: null },
      receivedByUserId: actor.userId,
    },
    orderBy: { receivedAt: 'desc' },
  });

  // Eligibility: a received FLOAT is reusable only while NO tenant session has
  // already consumed it as its opening fund (`openingHandoverId`). The check is
  // tenant-scoped and batch-loaded to avoid an N+1 query.
  const floatIds = floatRows.map((row) => row.id);
  const consumed = new Set<string>();
  if (floatIds.length > 0) {
    const reuses = await tx.cashSession.findMany({
      where: { tenantId, openingHandoverId: { in: floatIds } },
    });
    for (const session of reuses) {
      if (session.openingHandoverId !== null) {
        consumed.add(session.openingHandoverId);
      }
    }
  }

  // Authorization is evaluated PER ROW against the tagged instance BEFORE
  // totals/pagination, so a conditional grant can never widen the total.
  const visible = (row: CashHandover): boolean =>
    canInstanceAbility(
      actor,
      CASH_HANDOVER_READ_REQUIREMENT,
      handoverInstance(row),
    );
  const pending = pendingRows
    .filter(visible)
    .sort((left, right) => byCreatedAtAsc(left, right));
  const eligible = floatRows
    .filter(visible)
    .filter(hasReusableReceipt)
    .filter((row) => !consumed.has(row.id))
    .sort((left, right) => byReceivedAtDesc(left, right));

  // Batch-load the source session context for FLOAT items only: register id
  // and drawer-release state, nothing else.
  const sourceIds = [
    ...new Set(
      [...pending, ...eligible]
        .filter((row) => row.kind === 'FLOAT')
        .map((row) => row.sourceSessionId),
    ),
  ];
  const sourceSessions =
    sourceIds.length === 0
      ? []
      : await tx.cashSession.findMany({
          where: { tenantId, id: { in: sourceIds } },
        });
  const sourceById = new Map(
    sourceSessions.map((session) => [session.id, session]),
  );

  return document({
    pendingHandovers: {
      items: pending
        .slice(skip, skip + limit)
        .map((row) => custodyItem(row, sourceById.get(row.sourceSessionId))),
      page: pageNumber,
      limit,
      total: pending.length,
    },
    eligibleFloat: {
      items: eligible
        .slice(skip, skip + limit)
        .map((row) => custodyItem(row, sourceById.get(row.sourceSessionId))),
      page: pageNumber,
      limit,
      total: eligible.length,
    },
  });
}

/**
 * Reuse the SHARED receipt policy — the exact validation the authoritative
 * opening (`resolveOpeningFundCents`) runs. A received FLOAT whose receipt the
 * opening would reject (missing/invalid `receivedCents`, receipt before its
 * declaration, missing/mismatched receiver or receipt actor, non-FLOAT) is not
 * eligible/reusable. An explicit received amount that simply differs from the
 * declared amount stays eligible, because the opening fund is the RECEIVED
 * amount, not an equality of declared vs received.
 *
 * Only the expected domain violation is converted to "not eligible"; any other
 * (system/unexpected) error propagates instead of being swallowed.
 */
function hasReusableReceipt(row: CashHandover): boolean {
  const handover: DomainCashHandover = {
    id: row.id,
    sessionId: row.sourceSessionId,
    kind: 'FLOAT',
    declaredCents: row.declaredCents,
    receivedCents: row.receivedCents,
    senderUserId: row.createdByUserId,
    receiverUserId: row.recipientUserId,
    receiptActorUserId: row.receivedByUserId,
    declaredAt: row.createdAt,
    receivedAt: row.receivedAt,
  };
  try {
    resolveOpeningFundCents(handover);
    return true;
  } catch (error) {
    if (error instanceof BusinessRuleViolationError) {
      return false;
    }
    throw error;
  }
}

/**
 * Narrow custody item: identity, declared/received amounts, kind, sender and
 * timestamps. A FLOAT additionally exposes the source register and its
 * drawer-release state so the same-register release rule is interpretable;
 * no source-session expected totals, movements or snapshots are included.
 */
function custodyItem(
  row: CashHandover,
  source: CashSession | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    sessionId: row.sourceSessionId,
    kind: row.kind,
    declaredCents: row.declaredCents,
    receivedCents: row.receivedCents,
    senderUserId: row.createdByUserId,
    receiverUserId: row.recipientUserId,
    declaredAt: iso(row.createdAt),
    receivedAt: iso(row.receivedAt),
  };
  if (row.kind !== 'FLOAT') {
    return base;
  }
  return {
    ...base,
    sourceRegisterId: source ? source.registerId : null,
    sourceDrawerReleasedAt: source ? iso(source.drawerReleasedAt) : null,
  };
}

/** Oldest pending first; `id` breaks ties for stable pagination. */
function byCreatedAtAsc(left: CashHandover, right: CashHandover): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

/** Most recently received first; `id` breaks ties for stable pagination. */
function byReceivedAtDesc(left: CashHandover, right: CashHandover): number {
  const leftAt = left.receivedAt ? left.receivedAt.getTime() : 0;
  const rightAt = right.receivedAt ? right.receivedAt.getTime() : 0;
  return rightAt - leftAt || left.id.localeCompare(right.id);
}
