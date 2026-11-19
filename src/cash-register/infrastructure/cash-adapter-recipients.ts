/**
 * cash-redesign-reads S2 — handover recipient discovery.
 *
 * Lists the people a sender may address a handover to, so the client never
 * asks for a raw user UUID:
 *
 *   - active users (`User.isActive`) with a membership in the ACTIVE tenant
 *     (a tenant is a sucursal), loaded with an explicit `tenantId`;
 *   - whose role permissions grant `update:CashHandover` — the receipt
 *     permission — evaluated with the same CASL semantics the app uses for
 *     their effective ability (`manage` matches every action, `all` every
 *     subject), so `manage:all` roles are included;
 *   - minus the sender for a WITHDRAWAL, mirroring the CREATE_HANDOVER rule
 *     `CASH_HANDOVER_SELF_WITHDRAWAL`. A FLOAT addressed to oneself is valid
 *     (a cashier retaining their own float), so the sender stays listed.
 *
 * Only `{ userId, displayName, roleName }` is exposed: no email or other
 * user data. Discovery is a hint, not a guarantee: CREATE_HANDOVER and
 * RECEIVE_HANDOVER keep their own authoritative checks.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { assertAbility } from '../application/cash-authorization';
import type { CashActor, CashDocument } from '../cash-application.port';
import type { CashHandoverKind } from '../domain';
import type { TenantClient } from './cash-adapter-client';
import { document } from './cash-adapter-values';

/** The permission a recipient needs to confirm receipt. */
const RECEIPT_ACTION: AppActions = 'update';
const RECEIPT_SUBJECT: AppSubjects = 'CashHandover';

interface RolePermissionRow {
  permission: { action: string; subject: string };
}

/** Same rule construction as `CaslAbilityFactory` for one role's rows. */
function roleGrantsReceipt(rows: readonly RolePermissionRow[]): boolean {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const row of rows) {
    can(
      row.permission.action as AppActions,
      row.permission.subject as AppSubjects,
    );
  }
  return build().can(RECEIPT_ACTION, RECEIPT_SUBJECT);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'es', { sensitivity: 'base' });
}

export async function queryHandoverRecipients(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  handoverKind: CashHandoverKind,
): Promise<CashDocument> {
  // The sender's capability, not a user-directory read.
  assertAbility(actor, { action: 'create', subject: 'CashHandover' });
  const memberships = await tx.tenantMembership.findMany({
    where: { tenantId, user: { isActive: true } },
    select: {
      userId: true,
      user: { select: { name: true, isActive: true } },
      role: {
        select: {
          name: true,
          permissions: {
            select: {
              permission: { select: { action: true, subject: true } },
            },
          },
        },
      },
    },
  });
  const byUser = new Map<string, { displayName: string; roles: string[] }>();
  for (const membership of memberships) {
    if (!membership.user.isActive) {
      continue;
    }
    if (handoverKind === 'WITHDRAWAL' && membership.userId === actor.userId) {
      continue;
    }
    if (!roleGrantsReceipt(membership.role.permissions)) {
      continue;
    }
    const entry = byUser.get(membership.userId) ?? {
      displayName: membership.user.name,
      roles: [],
    };
    entry.roles.push(membership.role.name);
    byUser.set(membership.userId, entry);
  }
  const items = [...byUser.entries()]
    .map(([userId, entry]) => ({
      userId,
      displayName: entry.displayName,
      // A user granted receipt by several roles shows each granting role.
      roleName: [...new Set(entry.roles)].sort(compareNames).join(', '),
    }))
    .sort(
      (left, right) =>
        compareNames(left.displayName, right.displayName) ||
        left.userId.localeCompare(right.userId),
    );
  return document({ items });
}
