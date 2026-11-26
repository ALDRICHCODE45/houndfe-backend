/**
 * cash-register-held-by — the single "unreleased drawer" predicate.
 *
 * A register is held while it has a cash session whose drawer was never
 * released (`drawerReleasedAt IS NULL`), WHATEVER its status: a CLOSED
 * session with an unreleased drawer still blocks opening. The opening guard
 * (422 `CASH_REGISTER_UNRELEASED_SESSION`) and the `GET /cash-registers`
 * `drawerHeld` projection both build their filter here, so the selector and
 * the error can never disagree on the rule. `status` is display-only.
 *
 * The list value is a lock-free read-time snapshot; opening stays the
 * authoritative check under the register row lock. The partial unique index
 * `cash_sessions_one_unreleased_per_register` (migration
 * 20261007000100_cash_register_closing) serves this lookup and guarantees at
 * most one unreleased session per register; the projection still picks
 * deterministically (latest openedAt, then id) as a defense.
 */
import type { CashSession, Prisma } from '@prisma/client';
import {
  canAbility,
  CASH_SESSION_READ_REQUIREMENT,
} from '../application/cash-authorization';
import type { CashActor } from '../cash-application.port';
import type { TenantClient } from './cash-adapter-client';
import { isSessionVisible } from './cash-adapter-instances';
import { userNames } from './cash-adapter-storage';

export function unreleasedSessionWhere(
  tenantId: string,
  registerIds: readonly string[],
): Prisma.CashSessionWhereInput {
  return {
    tenantId,
    registerId: { in: [...registerIds] },
    drawerReleasedAt: null,
  };
}

export interface DrawerHoldFields {
  drawerHeld: boolean;
  drawerHeldStatus: string | null;
  drawerHeldSince: string | null;
  heldBy: {
    sessionId: string;
    status: string;
    openedAt: string;
    cashierDisplayName: string | null;
    byMe: boolean;
  } | null;
}

const NOT_HELD: DrawerHoldFields = {
  drawerHeld: false,
  drawerHeldStatus: null,
  drawerHeldSince: null,
  heldBy: null,
};

/**
 * Batched hold projection for already-visible registers: one session query
 * (never one per register) plus one display-name lookup limited to the
 * sessions the caller may see (GET /cash-sessions visibility rule).
 */
export async function registerDrawerHolds(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  registerIds: readonly string[],
): Promise<Map<string, DrawerHoldFields>> {
  const holds = new Map<string, DrawerHoldFields>(
    registerIds.map((id) => [id, NOT_HELD]),
  );
  if (registerIds.length === 0) {
    return holds;
  }
  const sessions = await tx.cashSession.findMany({
    where: unreleasedSessionWhere(tenantId, registerIds),
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
  });
  const holder = new Map<string, CashSession>();
  for (const session of sessions) {
    if (!holder.has(session.registerId)) {
      holder.set(session.registerId, session);
    }
  }
  // Same two gates as GET /cash-sessions: the read:CashSession grant first
  // (that route answers 403 without it), then the per-row visibility.
  const visible = canAbility(actor, CASH_SESSION_READ_REQUIREMENT)
    ? [...holder.values()].filter((session) => isSessionVisible(actor, session))
    : [];
  const names = await userNames(
    tx,
    visible.map((session) => session.cashierUserId),
  );
  const visibleIds = new Set(visible.map((session) => session.id));
  for (const [registerId, session] of holder) {
    const openedAt = session.openedAt.toISOString();
    holds.set(registerId, {
      drawerHeld: true,
      drawerHeldStatus: session.status,
      drawerHeldSince: openedAt,
      heldBy: visibleIds.has(session.id)
        ? {
            sessionId: session.id,
            status: session.status,
            openedAt,
            cashierDisplayName: names.get(session.cashierUserId) ?? null,
            byMe: session.cashierUserId === actor.userId,
          }
        : null,
    });
  }
  return holds;
}
