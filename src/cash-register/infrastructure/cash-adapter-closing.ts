/**
 * cash-register-closing / S10 — final cut / immutable closing snapshot (S7).
 *
 * Closing requires a submitted declaration, an independent verifier, a
 * released drawer and fully received/allocated custody. The frozen snapshot
 * carries expected/declared/verified amounts, per-channel differences,
 * actors, timestamps, folio and the original declaration timestamp, so a
 * later payment or catalog rename cannot rewrite a closed cut.
 */
import {
  CASH_RULE_CODES,
  assertCashFullyAllocated,
  assertIndependentCloser,
  cashRuleViolation,
  compareCashCounts,
  createCashClosingSnapshot,
  type CashHandoverKind,
  type CashSnapshotHandoverInput,
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
import { decodeCountLines, decodeExpectedSnapshot } from './cash-json';
import type { TenantClient } from './cash-adapter-client';
import {
  assertChannelExplanations,
  buildClosingChannels,
  cashCents,
} from './cash-adapter-count-rules';
import {
  assertCommandAbility,
  sessionInstance,
} from './cash-adapter-instances';
import { closingDocument, toDomainSession } from './cash-adapter-mappers';
import {
  latestCount,
  requireSessionLocked,
  userName,
} from './cash-adapter-storage';
import { json, newFolio, prismaJson } from './cash-adapter-values';

export async function close(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'CLOSE' }>,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, 'CLOSE', sessionInstance(session));
  if (session.status !== 'SUBMITTED') {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Closing requires a submitted declaration',
      { sessionId: session.id, status: session.status },
    );
  }
  assertIndependentCloser({
    cashierUserId: session.cashierUserId,
    closerUserId: actor.userId,
  });
  if (session.drawerReleasedAt === null) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DRAWER_NOT_RELEASED,
      'The drawer must be released before closing',
      { sessionId: session.id },
    );
  }
  const expected = decodeExpectedSnapshot(session.expectedJson);
  if (!expected) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Expected snapshot is missing for closing',
      { sessionId: session.id },
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
      'No declaration exists to close',
      { sessionId: session.id },
    );
  }
  const verification = await latestCount(
    tx,
    tenantId,
    session.id,
    'VERIFICATION',
  );
  if (!verification) {
    throw cashAppError(
      CASH_APPLICATION_CODES.VERIFICATION_REQUIRED,
      'An independent verification is required to close',
      { sessionId: session.id },
    );
  }
  const originalDeclaration = await tx.cashCount.findFirst({
    where: {
      tenantId,
      sessionId: session.id,
      kind: 'DECLARATION',
      revision: 1,
    },
  });
  if (!originalDeclaration) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DECLARATION_NOT_FOUND,
      'The original declaration is required to close',
      { sessionId: session.id },
    );
  }
  const declaredLines = decodeCountLines(declaration.linesJson);
  const verifiedLines = decodeCountLines(verification.linesJson);
  assertChannelExplanations(
    expected,
    declaredLines,
    verifiedLines,
    declaration.notes,
    verification.notes,
  );
  const declaredCash = cashCents(declaredLines);
  const verifiedCash = cashCents(verifiedLines);
  // Blocks close while an expected-dependent explanation is missing.
  const comparison = compareCashCounts({
    expectedCents: expected.cashExpectedCents,
    declaredCents: declaredCash,
    verifiedCents: verifiedCash,
    declarationNotes: declaration.notes,
    verificationNotes: verification.notes,
  });
  const handovers = await tx.cashHandover.findMany({
    where: { tenantId, sourceSessionId: session.id },
  });
  for (const handover of handovers) {
    if (handover.receivedAt === null) {
      throw cashAppError(
        CASH_APPLICATION_CODES.CUSTODY_NOT_RECEIVED,
        'All handovers must be received before closing',
        { handoverId: handover.id },
      );
    }
  }
  assertCashFullyAllocated({
    declaredCents: declaredCash,
    allocations: handovers.map((handover) => ({
      handoverId: handover.id,
      allocatedCents: handover.declaredCents,
    })),
  });
  const register = await tx.cashRegister.findFirst({
    where: { tenantId, id: session.registerId },
  });
  const folio = newFolio();
  const now = new Date();
  const domain = toDomainSession(session);
  const baseSnapshot = createCashClosingSnapshot({
    session: { ...domain, status: 'CLOSED' },
    folio,
    expectedCents: expected.cashExpectedCents,
    declaredCents: declaredCash,
    verifiedCents: verifiedCash,
    verifierUserId: verification.actorUserId,
    channels: buildClosingChannels(expected, declaredLines, verifiedLines),
    handovers: handovers.map(
      (handover): CashSnapshotHandoverInput => ({
        handoverId: handover.id,
        kind: handover.kind as CashHandoverKind,
        declaredCents: handover.declaredCents,
        receivedCents: handover.receivedCents,
        senderUserId: handover.createdByUserId,
        receiverUserId: handover.recipientUserId,
        receiptActorUserId: handover.receivedByUserId,
        declaredAt: handover.createdAt,
        receivedAt: handover.receivedAt,
      }),
    ),
    countedAt: originalDeclaration.createdAt,
    verifiedAt: verification.createdAt,
    closedAt: now,
    closedByUserId: actor.userId,
  });
  const snapshot = {
    ...baseSnapshot,
    registerName: register ? register.name : null,
    cashierName: await userName(tx, session.cashierUserId),
    verifierName: await userName(tx, verification.actorUserId),
    closedByName: await userName(tx, actor.userId),
    declarationNotes: declaration.notes ?? null,
    verificationNotes: verification.notes ?? null,
    comparison: comparison,
    closingNotes: command.notes ?? null,
  };
  const closingRow = await tx.cashClosing.create({
    data: {
      tenantId,
      sessionId: session.id,
      folio,
      closedByUserId: actor.userId,
      snapshotJson: prismaJson(snapshot),
    },
  });
  await tx.cashSession.update({
    where: { id: session.id },
    data: { status: 'CLOSED', closedAt: now },
  });
  return closingDocument(closingRow, json(snapshot));
}
