/**
 * cash-register-closing / S10 — custody: handover, receipt and drawer release (S2, S5).
 *
 * A handover allocates counted cash to a named recipient; only that recipient
 * may confirm receipt (no sender-only assertion of another's receipt). The
 * drawer is released only after every handover is received and the declared
 * cash is fully allocated. Lock order: source session before handover row.
 */
import {
  CASH_RULE_CODES,
  addCents,
  assertDrawerReleaseAllowed,
  assertHandoverReceipt,
  assertNonNegativeCents,
  assertStorageRangeCents,
  cashRuleViolation,
  type CashHandoverKind,
} from '../domain';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashCommand,
  CashDocument,
} from '../cash-application.port';
import { decodeCountLines } from './cash-json';
import type { TenantClient } from './cash-adapter-client';
import { cashCents } from './cash-adapter-count-rules';
import {
  assertCommandAbility,
  handoverInstance,
  sessionInstance,
} from './cash-adapter-instances';
import { handoverDocument, toDomainSession } from './cash-adapter-mappers';
import {
  assertActiveMember,
  assertSessionOwner,
  latestCount,
  lockHandoverRow,
  lockSessionRow,
  requireSessionLocked,
} from './cash-adapter-storage';
import { document, iso } from './cash-adapter-values';

export async function createHandover(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'CREATE_HANDOVER' }>,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, 'CREATE_HANDOVER', sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  if (session.status !== 'SUBMITTED') {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Handovers require a submitted declaration',
      { sessionId: session.id, status: session.status },
    );
  }
  if (
    command.handoverKind !== 'WITHDRAWAL' &&
    command.handoverKind !== 'FLOAT'
  ) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_NOT_FLOAT,
      'Unsupported handover kind',
      { handoverKind: command.handoverKind },
    );
  }
  assertNonNegativeCents(command.declaredCents, 'declaredCents');
  assertStorageRangeCents(command.declaredCents, 'declaredCents');
  await assertActiveMember(tx, tenantId, command.recipientUserId);
  if (
    command.handoverKind === 'WITHDRAWAL' &&
    command.recipientUserId === actor.userId
  ) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_SELF_WITHDRAWAL,
      'a withdrawal cannot be received by its own sender',
      { senderUserId: actor.userId },
    );
  }
  const declaration = await latestCount(
    tx,
    tenantId,
    session.id,
    'DECLARATION',
  );
  if (!declaration) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DECLARATION_NOT_FOUND,
      'No declaration exists for handover allocation',
      { sessionId: session.id },
    );
  }
  const declaredCash = cashCents(decodeCountLines(declaration.linesJson));
  const existing = await tx.cashHandover.findMany({
    where: { tenantId, sourceSessionId: session.id },
  });
  let allocated = command.declaredCents;
  for (const handover of existing) {
    allocated = addCents(allocated, handover.declaredCents, 'allocatedCents');
  }
  if (allocated > declaredCash) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_ALLOCATION_EXCEEDED,
      'Handovers cannot allocate more than the counted cash',
      { declaredCents: declaredCash, allocatedCents: allocated },
    );
  }
  const row = await tx.cashHandover.create({
    data: {
      tenantId,
      sourceSessionId: session.id,
      kind: command.handoverKind,
      recipientUserId: command.recipientUserId,
      createdByUserId: actor.userId,
      declaredCents: command.declaredCents,
      notes: command.notes ?? null,
    },
  });
  return handoverDocument(row);
}

export async function receiveHandover(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'RECEIVE_HANDOVER' }>,
): Promise<CashDocument> {
  const preview = await tx.cashHandover.findFirst({
    where: { tenantId, id: command.id },
  });
  if (!preview) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_NOT_FOUND,
      'Cash handover not found',
      { handoverId: command.id },
    );
  }
  // Lock order: source session before the handover row.
  await lockSessionRow(tx, tenantId, preview.sourceSessionId);
  const locked = await lockHandoverRow(tx, tenantId, command.id);
  if (!locked) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_NOT_FOUND,
      'Cash handover not found',
      { handoverId: command.id },
    );
  }
  const handover = await tx.cashHandover.findFirst({
    where: { tenantId, id: command.id },
  });
  if (!handover) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_NOT_FOUND,
      'Cash handover not found',
      { handoverId: command.id },
    );
  }
  assertCommandAbility(actor, 'RECEIVE_HANDOVER', handoverInstance(handover));
  if (handover.receivedAt !== null || handover.receivedByUserId !== null) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_ALREADY_RECEIVED,
      'This handover was already received',
      { handoverId: handover.id },
    );
  }
  if (handover.recipientUserId !== actor.userId) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_RECIPIENT_INVALID,
      'Only the designated recipient may confirm receipt',
      { handoverId: handover.id, recipientUserId: handover.recipientUserId },
    );
  }
  assertNonNegativeCents(command.receivedCents, 'receivedCents');
  assertStorageRangeCents(command.receivedCents, 'receivedCents');
  const receivedAt = new Date();
  assertHandoverReceipt({
    kind: handover.kind as CashHandoverKind,
    declaredCents: handover.declaredCents,
    receivedCents: command.receivedCents,
    senderUserId: handover.createdByUserId,
    receiverUserId: handover.recipientUserId,
    receiptActorUserId: actor.userId,
    declaredAt: handover.createdAt,
    receivedAt,
  });
  if (
    command.receivedCents !== handover.declaredCents &&
    !(typeof command.notes === 'string' && command.notes.trim().length > 0)
  ) {
    throw cashAppError(
      CASH_APPLICATION_CODES.RECEIPT_NOTES_REQUIRED,
      'A received amount that differs from the declared amount requires a note',
      { handoverId: handover.id },
    );
  }
  const updated = await tx.cashHandover.update({
    where: { id: handover.id },
    data: {
      receivedCents: command.receivedCents,
      receivedAt,
      receivedByUserId: actor.userId,
      receiptNotes: command.notes ?? null,
    },
  });
  return handoverDocument(updated);
}

export async function releaseDrawer(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  sessionId: string,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, sessionId);
  assertCommandAbility(actor, 'RELEASE_DRAWER', sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  if (session.drawerReleasedAt !== null) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DRAWER_ALREADY_RELEASED,
      'The drawer was already released',
      { sessionId: session.id },
    );
  }
  const declaration = await latestCount(
    tx,
    tenantId,
    session.id,
    'DECLARATION',
  );
  const declaredCash = declaration
    ? cashCents(decodeCountLines(declaration.linesJson))
    : null;
  const handovers = await tx.cashHandover.findMany({
    where: { tenantId, sourceSessionId: session.id },
  });
  for (const handover of handovers) {
    if (handover.receivedAt === null) {
      throw cashAppError(
        CASH_APPLICATION_CODES.CUSTODY_NOT_RECEIVED,
        'All handovers must be received before the drawer is released',
        { handoverId: handover.id },
      );
    }
  }
  assertDrawerReleaseAllowed({
    session: toDomainSession(session),
    declaredCountCents: declaredCash,
    allocations: handovers.map((handover) => ({
      handoverId: handover.id,
      allocatedCents: handover.declaredCents,
    })),
  });
  const now = new Date();
  await tx.cashSession.update({
    where: { id: session.id },
    data: { drawerReleasedAt: now },
  });
  return document({
    sessionId: session.id,
    drawerReleasedAt: iso(now),
  });
}
