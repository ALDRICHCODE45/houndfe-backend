/**
 * cash-redesign-reads T2 (S7) — closing list item projection.
 *
 * Each `GET /cash-closings` item carries the closed session's register and
 * cashier plus the cut's frozen difference, so the list no longer needs a
 * detail read per row. Lookups are BATCHED per page (at most one session,
 * one register and one user query, whatever the page size), and both the
 * DB-paged and the per-row visibility paths use this same projection.
 *
 * - `register` / `cashier`: ids from the source session; names are the
 *   CURRENT `CashRegister.name` / `User.name`, like the session list's
 *   `cashierDisplayName`. The frozen names stay in the closing snapshot.
 * - `differenceCents`: declared − expected physical cash, read from the
 *   frozen snapshot (`comparison.declarationDifferenceCents`, else
 *   `declaredCents − expectedCents`), never recomputed from live rows;
 *   `null` when the snapshot carries neither.
 */
import type { CashClosing, CashSession, Prisma } from '@prisma/client';
import type { CashJson } from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import { userNames } from './cash-adapter-storage';
import { iso } from './cash-adapter-values';

type ClosingSession = Pick<CashSession, 'id' | 'registerId' | 'cashierUserId'>;

export async function closingListItems(
  tx: TenantClient,
  tenantId: string,
  rows: readonly CashClosing[],
  knownSessions?: ReadonlyMap<string, ClosingSession>,
): Promise<CashJson[]> {
  if (rows.length === 0) {
    return [];
  }
  const sessionById = knownSessions ?? (await loadSessions(tx, tenantId, rows));
  const sessions = rows
    .map((row) => sessionById.get(row.sessionId))
    .filter((session): session is ClosingSession => session !== undefined);
  const registerIds = [...new Set(sessions.map((s) => s.registerId))];
  const registers =
    registerIds.length > 0
      ? await tx.cashRegister.findMany({
          where: { tenantId, id: { in: registerIds } },
          select: { id: true, name: true },
        })
      : [];
  const registerName = new Map(registers.map((r) => [r.id, r.name]));
  const names = await userNames(
    tx,
    sessions.map((session) => session.cashierUserId),
  );
  return rows.map((row) => {
    const session = sessionById.get(row.sessionId);
    return {
      id: row.id,
      sessionId: row.sessionId,
      folio: row.folio,
      createdAt: iso(row.createdAt),
      register: session
        ? {
            id: session.registerId,
            name: registerName.get(session.registerId) ?? null,
          }
        : null,
      cashier: session
        ? {
            userId: session.cashierUserId,
            displayName: names.get(session.cashierUserId) ?? null,
          }
        : null,
      differenceCents: closingDifferenceCents(row.snapshotJson),
    };
  });
}

async function loadSessions(
  tx: TenantClient,
  tenantId: string,
  rows: readonly CashClosing[],
): Promise<Map<string, ClosingSession>> {
  const ids = [...new Set(rows.map((row) => row.sessionId))];
  const sessions = await tx.cashSession.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, registerId: true, cashierUserId: true },
  });
  return new Map(sessions.map((session) => [session.id, session]));
}

/** Frozen declared − expected cash difference, or `null` when absent. */
export function closingDifferenceCents(
  snapshot: Prisma.JsonValue,
): number | null {
  if (!isObject(snapshot)) {
    return null;
  }
  const comparison = snapshot.comparison;
  if (
    isObject(comparison) &&
    isSafeInteger(comparison.declarationDifferenceCents)
  ) {
    return comparison.declarationDifferenceCents;
  }
  const { declaredCents, expectedCents } = snapshot;
  if (isSafeInteger(declaredCents) && isSafeInteger(expectedCents)) {
    const difference = declaredCents - expectedCents;
    return Number.isSafeInteger(difference) ? difference : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
