/**
 * cash-register-closing / S10 — storage primitives: locks, membership, loads (S8).
 *
 * Every read/write carries an explicit `tenantId`; cross-tenant rows fail
 * closed as not-found before details are returned.
 *
 * Lock order is register -> session -> handover. A FLOAT open locks the
 * source session before the handover row; a receipt locks the source session
 * before the handover row. `assertOpenSession`/the ledger path lock the
 * session before sales/refunds take their own locks.
 */
import type {
  CashCount,
  CashMovement,
  CashSession,
  User,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  assertOperationalWriteAllowed,
  type CashMovement as DomainCashMovement,
} from '../domain';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type { TenantClient } from './cash-adapter-client';
import { toDomainMovement, toDomainSession } from './cash-adapter-mappers';

export async function lockRegisterRow(
  tx: TenantClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "cash_registers" WHERE "tenantId" = ${tenantId} AND "id" = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function lockSessionRow(
  tx: TenantClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "cash_sessions" WHERE "tenantId" = ${tenantId} AND "id" = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function lockHandoverRow(
  tx: TenantClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "cash_handovers" WHERE "tenantId" = ${tenantId} AND "id" = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}

export async function requireSessionLocked(
  tx: TenantClient,
  tenantId: string,
  id: string,
): Promise<CashSession> {
  const locked = await lockSessionRow(tx, tenantId, id);
  if (!locked) {
    throw cashAppError(
      CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
      'Cash session not found',
      { sessionId: id },
    );
  }
  const row = await tx.cashSession.findFirst({ where: { tenantId, id } });
  if (!row) {
    throw cashAppError(
      CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
      'Cash session not found',
      { sessionId: id },
    );
  }
  return row;
}

export async function requireSessionForLedger(
  tx: TenantClient,
  tenantId: string,
  sessionId: string,
  actorId: string,
): Promise<CashSession> {
  // S8 — the ledger path independently takes the SAME session row lock as
  // `assertOpenSession` and re-checks active membership. A caller cannot be
  // required to pre-call assertOpenSession, and a concurrent freeze can no
  // longer land between this read and the movement write.
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
  return session;
}

export function requireAmbientTransaction(
  inTransaction: boolean,
  method: string,
): void {
  if (!inTransaction) {
    throw cashAppError(
      CASH_APPLICATION_CODES.LEDGER_OUTSIDE_TRANSACTION,
      `${method} requires the caller's ambient transaction`,
    );
  }
}

export async function assertActiveMember(
  tx: TenantClient,
  tenantId: string,
  userId: string,
): Promise<User> {
  const user = await tx.user.findFirst({ where: { id: userId } });
  if (!user || !user.isActive) {
    throw cashAppError(
      CASH_APPLICATION_CODES.ACTOR_INACTIVE,
      'Cash actor is not an active user',
      { userId },
    );
  }
  const membership = await tx.tenantMembership.findFirst({
    where: { userId, tenantId },
  });
  if (!membership) {
    throw cashAppError(
      CASH_APPLICATION_CODES.TENANT_MEMBERSHIP_REQUIRED,
      'Cash actor is not a member of the active tenant',
      { userId, tenantId },
    );
  }
  return user;
}

export async function userName(
  tx: TenantClient,
  userId: string,
): Promise<string | null> {
  const user = await tx.user.findFirst({ where: { id: userId } });
  return user ? user.name : null;
}

export function assertSessionOwner(session: CashSession, userId: string): void {
  if (session.cashierUserId !== userId) {
    throw cashAppError(
      CASH_APPLICATION_CODES.SESSION_NOT_OWNED,
      'Only the session owner may perform this action',
      { sessionId: session.id },
    );
  }
}

export async function loadSessionMovements(
  tx: TenantClient,
  tenantId: string,
  sessionId: string,
): Promise<DomainCashMovement[]> {
  const rows = await tx.cashMovement.findMany({
    where: { tenantId, sessionId },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((row) => toDomainMovement(row));
}

export async function latestCount(
  tx: TenantClient,
  tenantId: string,
  sessionId: string,
  kind: 'DECLARATION' | 'VERIFICATION',
): Promise<CashCount | null> {
  return tx.cashCount.findFirst({
    where: { tenantId, sessionId, kind },
    orderBy: { revision: 'desc' },
  });
}

export type { CashMovement };
