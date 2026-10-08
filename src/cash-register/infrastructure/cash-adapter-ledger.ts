/**
 * cash-register-closing / S10 — transaction-bound POS ledger (S6, S8).
 *
 * The sales path owns payment writes; cash owns custody. Each method requires
 * the caller's ambient transaction and independently takes the SAME session
 * row lock as the command path, then checks tenant, active membership, owner
 * and OPEN before any movement is written. Source uniqueness fails closed
 * instead of silently double-applying money.
 */
import type { CashSession } from '@prisma/client';
import {
  CASH_RULE_CODES,
  addCents,
  assertNonEmptyText,
  assertOperationalWriteAllowed,
  assertStorageRangeCents,
  assertValidCashMovement,
  cashRuleViolation,
  expectedCashCents,
  resolveCashChannel,
  type CashMovement as DomainCashMovement,
} from '../domain';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type { CashLedgerPayment, CashPaymentMethod } from '../cash-ledger.port';
import type { TenantClient } from './cash-adapter-client';
import { planLedgerPayments } from './cash-adapter-ledger-movements';
import { toDomainSession } from './cash-adapter-mappers';
import {
  assertActiveMember,
  loadSessionMovements,
  requireSessionForLedger,
  requireSessionLocked,
} from './cash-adapter-storage';
import {
  isUniqueViolation,
  ledgerMethodToCashMethod,
} from './cash-adapter-values';

export async function assertOpenSession(
  tx: TenantClient,
  tenantId: string,
  sessionId: string,
  actorId: string,
): Promise<void> {
  const session = await requireSessionLocked(tx, tenantId, sessionId);
  await assertActiveMember(tx, tenantId, actorId);
  if (session.cashierUserId !== actorId) {
    throw cashAppError(
      CASH_APPLICATION_CODES.SESSION_NOT_OWNED,
      'Only the session owner may bind POS money to this session',
      { sessionId },
    );
  }
  assertOperationalWriteAllowed(toDomainSession(session));
}

export async function recordPayments(
  tx: TenantClient,
  tenantId: string,
  input: {
    sessionId: string;
    actorId: string;
    saleId: string;
    payments: readonly CashLedgerPayment[];
    changeDueCents: number;
    occurredAt: Date;
  },
): Promise<void> {
  const session = await requireSessionForLedger(
    tx,
    tenantId,
    input.sessionId,
    input.actorId,
  );
  assertNonEmptyText(input.saleId, 'saleId');
  assertStorageRangeCents(input.changeDueCents, 'changeDueCents');

  const planned = planLedgerPayments(session.id, input);
  // Empty tender + zero change (e.g. a credit-only initial charge bound to
  // a session) is an accepted no-op after OPEN/ownership validation: no
  // CREDIT row is ever inserted.
  if (planned.length === 0) {
    return;
  }
  await persistLedgerMovements(tx, tenantId, session, input.actorId, {
    movements: planned,
    occurredAt: input.occurredAt,
  });
}

export async function recordRefund(
  tx: TenantClient,
  tenantId: string,
  input: {
    sessionId: string;
    actorId: string;
    settlementId: string;
    amountCents: number;
    method: CashPaymentMethod;
    occurredAt: Date;
  },
): Promise<void> {
  const session = await requireSessionForLedger(
    tx,
    tenantId,
    input.sessionId,
    input.actorId,
  );
  assertNonEmptyText(input.settlementId, 'settlementId');
  if (input.amountCents <= 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.MOVEMENT_ZERO_DELTA,
      'a refund settlement must settle a positive amount',
      { amountCents: input.amountCents },
    );
  }
  const method = ledgerMethodToCashMethod(input.method);
  const channel = resolveCashChannel({ method });
  const movement: DomainCashMovement = {
    sessionId: session.id,
    deltaCents: -input.amountCents,
    method,
    channelKey: channel.channelKey,
    channelLabel: channel.channelLabel,
    kind: 'REFUND_SETTLEMENT',
    sourceType: 'REFUND',
    sourceId: input.settlementId,
  };
  assertValidCashMovement(movement);
  await persistLedgerMovements(tx, tenantId, session, input.actorId, {
    movements: [movement],
    occurredAt: input.occurredAt,
  });
}

async function persistLedgerMovements(
  tx: TenantClient,
  tenantId: string,
  session: CashSession,
  actorId: string,
  input: {
    movements: readonly DomainCashMovement[];
    occurredAt: Date;
  },
): Promise<void> {
  // Bound the physical money sum before any write.
  const existing = await loadSessionMovements(tx, tenantId, session.id);
  let expected = expectedCashCents({
    openingCents: session.openingCents,
    movements: existing,
  });
  for (const movement of input.movements) {
    assertValidCashMovement(movement);
    if (movement.method === 'CASH') {
      expected = addCents(expected, movement.deltaCents, 'expectedCashCents');
    }
  }
  // Source uniqueness fails closed rather than silently double-applying.
  for (const movement of input.movements) {
    const duplicate = await tx.cashMovement.findFirst({
      where: {
        tenantId,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
      },
    });
    if (duplicate) {
      throw cashRuleViolation(
        CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
        'cash movement source already recorded',
        {
          sourceType: movement.sourceType,
          sourceId: movement.sourceId,
        },
      );
    }
  }
  try {
    await tx.cashMovement.createMany({
      data: input.movements.map((movement) => ({
        tenantId,
        sessionId: session.id,
        kind: movement.kind,
        deltaCents: movement.deltaCents,
        method: movement.method,
        channelKey: movement.channelKey,
        channelLabel: movement.channelLabel,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        actorUserId: actorId,
        reason: movement.reason ?? null,
        occurredAt: input.occurredAt,
      })),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
        'cash movement source already recorded',
        { sessionId: session.id },
      );
    }
    throw error;
  }
}
