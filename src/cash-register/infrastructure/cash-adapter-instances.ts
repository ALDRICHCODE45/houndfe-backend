/**
 * cash-register-closing / S10 — authorization instances and replay rechecks (S3).
 *
 * CASL conditions are only evaluated against a tagged object, so every
 * command/read builds the instance from authoritative persisted (or, for a
 * prospective create, server-owned) context. Body-supplied actor/expected
 * fields are NEVER used here: only row columns and the authenticated user.
 *
 * There are NO named-role checks. Permission possession is rechecked on every
 * action; ownership/state/receiver constraints are enforced separately by the
 * command modules.
 */
import type { Prisma } from '@prisma/client';
import type {
  CashClosing,
  CashHandover,
  CashRegister,
  CashSession,
} from '@prisma/client';
import {
  CASH_AUDIT_REQUIREMENT,
  CASH_CLOSING_READ_REQUIREMENT,
  CASH_COMMAND_ABILITY,
  CASH_SESSION_READ_REQUIREMENT,
  assertAbility,
  canInstanceAbility,
} from '../application/cash-authorization';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type { CashActor, CashCommand } from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import { documentValue, isRecord } from './cash-adapter-values';

export function registerInstance(row: CashRegister): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    registerId: row.id,
    id: row.id,
    name: row.name,
    isActive: row.isActive,
  };
}

export function sessionInstance(row: CashSession): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    sessionId: row.id,
    id: row.id,
    registerId: row.registerId,
    cashierUserId: row.cashierUserId,
    ownerUserId: row.cashierUserId,
    status: row.status,
  };
}

export function handoverInstance(row: CashHandover): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    handoverId: row.id,
    id: row.id,
    sessionId: row.sourceSessionId,
    senderUserId: row.createdByUserId,
    recipientUserId: row.recipientUserId,
    handoverKind: row.kind,
  };
}

/**
 * Per-row session visibility: an owned row needs the base subject to match
 * the instance; otherwise the wider audit subject must match it. Both are
 * evaluated against a tagged instance, never the bare string subject.
 */
export function isSessionVisible(actor: CashActor, row: CashSession): boolean {
  const instance = sessionInstance(row);
  if (
    row.cashierUserId === actor.userId &&
    canInstanceAbility(actor, CASH_SESSION_READ_REQUIREMENT, instance)
  ) {
    return true;
  }
  return canInstanceAbility(actor, CASH_AUDIT_REQUIREMENT, instance);
}

export function closingInstance(
  row: CashClosing,
  session: CashSession | null,
): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    closingId: row.id,
    id: row.id,
    sessionId: row.sessionId,
    registerId: session ? session.registerId : null,
    cashierUserId: session ? session.cashierUserId : null,
    closedByUserId: row.closedByUserId,
  };
}

/** Per-row closing visibility (base instance or wider audit instance). */
export function isClosingVisible(
  actor: CashActor,
  row: CashClosing,
  session: CashSession | null,
): boolean {
  const instance = closingInstance(row, session);
  const ownsClosing = row.closedByUserId === actor.userId;
  const ownsSession =
    session !== null && session.cashierUserId === actor.userId;
  if (
    (ownsClosing || ownsSession) &&
    canInstanceAbility(actor, CASH_CLOSING_READ_REQUIREMENT, instance)
  ) {
    return true;
  }
  return canInstanceAbility(actor, CASH_AUDIT_REQUIREMENT, instance);
}

/** Instance-scoped recheck of a command's coarse capability. */
export function assertCommandAbility(
  actor: CashActor,
  kind: CashCommand['kind'],
  instance: Record<string, unknown>,
): void {
  assertAbility(actor, CASH_COMMAND_ABILITY[kind], instance);
}

/**
 * S3 — read the authoritative target of a STORED command and recheck the
 * instance condition against it. Lifecycle state is deliberately not
 * re-validated: an exact key retry must still replay, but a revoked
 * (or now-non-matching) permission must fail closed.
 */
export async function recheckReplayAbility(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: CashCommand,
  storedResponse: Prisma.JsonValue,
): Promise<void> {
  switch (command.kind) {
    case 'CREATE_REGISTER':
      assertCommandAbility(actor, command.kind, {
        tenantId,
        ownerUserId: actor.userId,
      });
      return;
    case 'OPEN_SESSION': {
      const response = documentValue(storedResponse);
      const session = response.session;
      const row =
        isRecord(session) && typeof session.id === 'string'
          ? await tx.cashSession.findFirst({
              where: {
                tenantId,
                id: session.id,
                registerId: command.registerId,
                cashierUserId: actor.userId,
              },
            })
          : null;
      if (!row) {
        throw cashAppError(
          CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
          'The original cash session was not found',
        );
      }
      assertCommandAbility(actor, command.kind, sessionInstance(row));
      return;
    }
    case 'UPDATE_REGISTER': {
      const id = command.id;
      const row = await tx.cashRegister.findFirst({
        where: { tenantId, id },
      });
      if (!row) {
        throw cashAppError(
          CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
          'Cash register not found',
          { registerId: id },
        );
      }
      assertCommandAbility(actor, command.kind, registerInstance(row));
      return;
    }
    case 'RECEIVE_HANDOVER': {
      const row = await tx.cashHandover.findFirst({
        where: { tenantId, id: command.id },
      });
      if (!row) {
        throw cashAppError(
          CASH_APPLICATION_CODES.HANDOVER_NOT_FOUND,
          'Cash handover not found',
          { handoverId: command.id },
        );
      }
      assertCommandAbility(actor, command.kind, handoverInstance(row));
      return;
    }
    default: {
      const row = await tx.cashSession.findFirst({
        where: { tenantId, id: command.sessionId },
      });
      if (!row) {
        throw cashAppError(
          CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
          'Cash session not found',
          { sessionId: command.sessionId },
        );
      }
      assertCommandAbility(actor, command.kind, sessionInstance(row));
      return;
    }
  }
}
