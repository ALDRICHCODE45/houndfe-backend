/**
 * cash-register-closing / S10 — row → document/domain mappers (S1, S7).
 *
 * Pure translation between Prisma rows and the JSON documents/domain models
 * the ports expose. No transaction, lock or query logic lives here, so the
 * storage, command and query modules can share these mappers without a
 * dependency cycle.
 */
import type {
  CashClosing,
  CashCount,
  CashHandover,
  CashMovement,
  CashRegister,
  CashSession,
} from '@prisma/client';
import type { CashDocument, CashJson } from '../cash-application.port';
import type {
  CashMovement as DomainCashMovement,
  CashSession as DomainCashSession,
} from '../domain';
import { decodeCountLines, decodeDenominations } from './cash-json';
import { asCashMethod, document, iso, json } from './cash-adapter-values';

export function registerDocument(row: CashRegister): CashDocument {
  return document({
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    createdAt: iso(row.createdAt),
  });
}

export function closingDocument(
  row: CashClosing,
  snapshot: CashJson,
): CashDocument {
  return document({
    id: row.id,
    sessionId: row.sessionId,
    folio: row.folio,
    createdAt: iso(row.createdAt),
    snapshot: withOpenedAt(snapshot),
  });
}

/**
 * cash-redesign-reads T2 (S7) — CLOSE freezes `openedAt` (the session's
 * opening time) into every new snapshot. A snapshot frozen before that has
 * no such key; the read exposes it as `null` instead of deriving it from the
 * live session, because a closed cut is frozen and must not gain values it
 * did not record. The stored row is never rewritten.
 */
function withOpenedAt(snapshot: CashJson): CashJson {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    'openedAt' in snapshot
  ) {
    return snapshot;
  }
  return { ...snapshot, openedAt: null };
}

export function handoverDocument(row: CashHandover): CashDocument {
  return document({
    id: row.id,
    sessionId: row.sourceSessionId,
    kind: row.kind,
    declaredCents: row.declaredCents,
    receivedCents: row.receivedCents,
    senderUserId: row.createdByUserId,
    receiverUserId: row.recipientUserId,
    receiptActorUserId: row.receivedByUserId,
    declaredAt: iso(row.createdAt),
    receivedAt: iso(row.receivedAt),
    notes: row.notes,
    receiptNotes: row.receiptNotes,
  });
}

export function movementDocument(row: CashMovement): CashJson {
  return {
    id: row.id,
    kind: row.kind,
    deltaCents: row.deltaCents,
    method: asCashMethod(row.method),
    channelKey: row.channelKey,
    channelLabel: row.channelLabel,
    sourceType: row.sourceType as CashJson,
    sourceId: row.sourceId,
    actorUserId: row.actorUserId,
    reason: row.reason,
    occurredAt: iso(row.occurredAt),
  };
}

export function countDocument(row: CashCount): CashJson {
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    actorUserId: row.actorUserId,
    lines: json(decodeCountLines(row.linesJson)),
    denominations: json(decodeDenominations(row.denominationsJson)),
    notes: row.notes,
    createdAt: iso(row.createdAt),
  };
}

export function toDomainSession(row: CashSession): DomainCashSession {
  return {
    id: row.id,
    tenantId: row.tenantId,
    registerId: row.registerId,
    cashierUserId: row.cashierUserId,
    status: row.status,
    openingCents: row.openingCents,
    frozenAt: row.frozenAt,
    drawerReleasedAt: row.drawerReleasedAt,
  };
}

export function toDomainMovement(row: CashMovement): DomainCashMovement {
  return {
    sessionId: row.sessionId,
    deltaCents: row.deltaCents,
    method: asCashMethod(row.method),
    channelKey: row.channelKey,
    channelLabel: row.channelLabel,
    kind: row.kind,
    sourceType: row.sourceType as DomainCashMovement['sourceType'],
    sourceId: row.sourceId,
    reason: row.reason,
  };
}
