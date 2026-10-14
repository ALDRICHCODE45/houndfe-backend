/**
 * cash-register-closing / S10 — opening a session and resolving its FLOAT (S5).
 *
 * The opening fund is counted once and must equal the received FLOAT carried
 * over from a released source session. Lock order: the source session is
 * locked BEFORE the handover row, matching the receipt path so no deadlock
 * cycle can form.
 */
import { randomUUID } from 'crypto';
import type { CashRegister } from '@prisma/client';
import {
  CASH_RULE_CODES,
  assertNonNegativeCents,
  assertStorageRangeCents,
  cashRuleViolation,
  projectCashSession,
  resolveOpeningFundCents,
} from '../domain';
import {
  CASH_AUDIT_REQUIREMENT,
  canInstanceAbility,
} from '../application/cash-authorization';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashCommand,
  CashDocument,
} from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import {
  assertCommandAbility,
  sessionInstance,
} from './cash-adapter-instances';
import { toDomainSession } from './cash-adapter-mappers';
import {
  lockHandoverRow,
  lockRegisterRow,
  lockSessionRow,
} from './cash-adapter-storage';
import { document } from './cash-adapter-values';

export async function openSession(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'OPEN_SESSION' }>,
): Promise<CashDocument> {
  const registerLocked = await lockRegisterRow(
    tx,
    tenantId,
    command.registerId,
  );
  if (!registerLocked) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
      'Cash register not found',
      { registerId: command.registerId },
    );
  }
  const register = await tx.cashRegister.findFirst({
    where: { tenantId, id: command.registerId },
  });
  if (!register) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
      'Cash register not found',
      { registerId: command.registerId },
    );
  }
  const sessionId = randomUUID();
  assertCommandAbility(actor, 'OPEN_SESSION', {
    tenantId,
    id: sessionId,
    sessionId,
    registerId: register.id,
    cashierUserId: actor.userId,
    ownerUserId: actor.userId,
    status: 'OPEN',
  });
  if (!register.isActive) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_INACTIVE,
      'Cash register is inactive',
      { registerId: register.id },
    );
  }
  if (command.openingConfirmed !== true) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_NOT_CONFIRMED,
      'Opening the drawer requires an explicit confirmation',
      { registerId: register.id },
    );
  }
  assertNonNegativeCents(command.openingCents, 'openingCents');
  assertStorageRangeCents(command.openingCents, 'openingCents');

  const unreleased = await tx.cashSession.findFirst({
    where: { tenantId, registerId: register.id, drawerReleasedAt: null },
  });
  if (unreleased) {
    throw cashAppError(
      CASH_APPLICATION_CODES.REGISTER_UNRELEASED_SESSION,
      'The register already has an unreleased cash session',
      { registerId: register.id, sessionId: unreleased.id },
    );
  }

  let openingHandoverId: string | null = null;
  if (command.openingHandoverId !== undefined) {
    openingHandoverId = await resolveOpeningHandover(
      tx,
      tenantId,
      actor,
      register,
      command.openingHandoverId,
      command.openingCents,
    );
  }

  const row = await tx.cashSession.create({
    data: {
      id: sessionId,
      tenantId,
      registerId: register.id,
      cashierUserId: actor.userId,
      openingCents: command.openingCents,
      status: 'OPEN',
      openingHandoverId,
    },
  });
  const domain = toDomainSession(row);
  const hasAudit = canInstanceAbility(
    actor,
    CASH_AUDIT_REQUIREMENT,
    sessionInstance(row),
  );
  const projection = projectCashSession({
    session: domain,
    viewerUserId: actor.userId,
    expectedCashCents: row.openingCents,
    declaredCents: null,
    hasAuditVisibility: hasAudit,
    declarationSubmitted: false,
  });
  return document({
    session: projection,
    register: {
      id: register.id,
      name: register.name,
      isActive: register.isActive,
    },
  });
}

/**
 * Validate a FLOAT opening. Lock order: the source session is locked
 * BEFORE the handover row, matching the receipt path so no deadlock cycle
 * can form.
 */
async function resolveOpeningHandover(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  register: CashRegister,
  handoverId: string,
  openingCents: number,
): Promise<string> {
  const preview = await tx.cashHandover.findFirst({
    where: { tenantId, id: handoverId },
  });
  if (!preview) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_HANDOVER_NOT_FOUND,
      'Opening FLOAT handover not found',
      { handoverId },
    );
  }
  await lockSessionRow(tx, tenantId, preview.sourceSessionId);
  const handover = await tx.cashHandover.findFirst({
    where: { tenantId, id: handoverId },
  });
  if (!handover) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_HANDOVER_NOT_FOUND,
      'Opening FLOAT handover not found',
      { handoverId },
    );
  }
  await lockHandoverRow(tx, tenantId, handover.id);
  const sourceSession = await tx.cashSession.findFirst({
    where: { tenantId, id: handover.sourceSessionId },
  });
  if (!sourceSession) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_HANDOVER_NOT_FOUND,
      'Opening FLOAT source session not found',
      { handoverId },
    );
  }
  if (handover.kind !== 'FLOAT') {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_NOT_FLOAT,
      'only a retained FLOAT handover can fund the next session',
      { handoverKind: handover.kind },
    );
  }
  if (
    handover.recipientUserId !== actor.userId ||
    handover.receivedByUserId !== actor.userId
  ) {
    throw cashAppError(
      CASH_APPLICATION_CODES.HANDOVER_RECIPIENT_INVALID,
      'The opening FLOAT must have been received by the opening cashier',
      { handoverId, userId: actor.userId },
    );
  }
  const received = resolveOpeningFundCents({
    id: handover.id,
    sessionId: handover.sourceSessionId,
    kind: 'FLOAT',
    declaredCents: handover.declaredCents,
    receivedCents: handover.receivedCents,
    senderUserId: handover.createdByUserId,
    receiverUserId: handover.recipientUserId,
    receiptActorUserId: handover.receivedByUserId,
    declaredAt: handover.createdAt,
    receivedAt: handover.receivedAt,
  });
  if (received !== openingCents) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_FUNDS_MISMATCH,
      'The opening fund must equal the received FLOAT amount',
      { openingCents, receivedCents: received },
    );
  }
  if (
    sourceSession.registerId === register.id &&
    sourceSession.drawerReleasedAt === null
  ) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_SOURCE_DRAWER_NOT_RELEASED,
      'The source drawer must be released before its funds are reused on the same register',
      { sourceSessionId: sourceSession.id },
    );
  }
  const reuse = await tx.cashSession.findFirst({
    where: { tenantId, openingHandoverId: handover.id },
  });
  if (reuse) {
    throw cashAppError(
      CASH_APPLICATION_CODES.OPENING_FLOAT_REUSE,
      'This FLOAT handover already funds another session',
      { handoverId: handover.id, sessionId: reuse.id },
    );
  }
  return handover.id;
}
