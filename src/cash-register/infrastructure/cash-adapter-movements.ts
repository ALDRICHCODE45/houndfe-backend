/**
 * cash-register-closing / S10 — manual cash-in / cash-out commands (S6).
 *
 * Manual movements require a reason and an OPEN owner session. The physical
 * money sum is bounded before any write, and the movement is bound by session
 * identity, not a mutable effective timestamp.
 */
import { randomUUID } from 'crypto';
import {
  POOLED_CASH_CHANNEL,
  addCents,
  assertNonEmptyText,
  assertNonNegativeCents,
  assertOperationalWriteAllowed,
  assertStorageRangeCents,
  assertValidCashMovement,
  expectedCashCents,
  type CashMovement as DomainCashMovement,
} from '../domain';
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
  assertSessionOwner,
  loadSessionMovements,
  requireSessionLocked,
} from './cash-adapter-storage';
import { document, iso } from './cash-adapter-values';

export async function manualMovement(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'CASH_IN' | 'CASH_OUT' }>,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, command.kind, sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  const domain = toDomainSession(session);
  assertOperationalWriteAllowed(domain);
  assertNonNegativeCents(command.amountCents, 'amountCents');
  assertStorageRangeCents(command.amountCents, 'amountCents');
  const reason = assertNonEmptyText(command.reason, 'reason');
  const signed =
    command.kind === 'CASH_IN' ? command.amountCents : -command.amountCents;
  const movement: DomainCashMovement = {
    sessionId: session.id,
    deltaCents: signed,
    method: 'CASH',
    channelKey: POOLED_CASH_CHANNEL.channelKey,
    channelLabel: POOLED_CASH_CHANNEL.channelLabel,
    kind: command.kind,
    sourceType: 'MANUAL',
    sourceId: randomUUID(),
    reason,
  };
  assertValidCashMovement(movement);
  // Bound the physical money sum before any write.
  const existing = await loadSessionMovements(tx, tenantId, session.id);
  const before = expectedCashCents({
    openingCents: session.openingCents,
    movements: existing,
  });
  addCents(before, signed, 'expectedCashCents');
  const row = await tx.cashMovement.create({
    data: {
      tenantId,
      sessionId: session.id,
      kind: command.kind,
      deltaCents: signed,
      method: 'CASH',
      channelKey: movement.channelKey,
      channelLabel: movement.channelLabel,
      sourceType: 'MANUAL',
      sourceId: movement.sourceId,
      actorUserId: actor.userId,
      reason,
      occurredAt: new Date(),
    },
  });
  return document({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    deltaCents: row.deltaCents,
    occurredAt: iso(row.occurredAt),
  });
}
