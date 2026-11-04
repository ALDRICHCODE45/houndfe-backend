import { Prisma } from '@prisma/client';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { InventoryContractError } from './inventory-contract';

export interface InventoryPrincipal {
  actorId: string;
  tenantId: string;
}

/**
 * Owned transaction only, after the tenant SHARE lock. Re-checks the actor and
 * the persisted grant edges (locked FOR SHARE) and returns the actor's current
 * `users.name`, read under the same lock, for the movement snapshot.
 *
 * READ needs journal read. ADJUST needs the adjustment grant and journal read
 * (the response carries the stock snapshot); nothing is inherited from
 * Product/Sale subjects.
 */
export async function requireInventoryAuthority(
  tx: Prisma.TransactionClient,
  scope: InventoryPrincipal,
  operation: 'READ' | 'ADJUST',
): Promise<{ displayName: string }> {
  const actors = await tx.$queryRaw<
    { id: string; isActive: boolean; name: string }[]
  >(Prisma.sql`
    SELECT u."id", u."isActive", u."name" FROM "users" u
    WHERE u."id" = ${scope.actorId} FOR SHARE OF u
  `);
  if (actors[0]?.id !== scope.actorId || actors[0].isActive !== true)
    throw new InventoryContractError('UNAUTHORIZED');
  const grants = await tx.$queryRaw<
    { action: string; subject: string }[]
  >(Prisma.sql`
    SELECT p."action", p."subject"
    FROM "tenant_memberships" m
    JOIN "roles" r ON r."id" = m."roleId"
      AND (r."tenantId" = m."tenantId" OR r."tenantId" IS NULL)
    JOIN "role_permissions" rp ON rp."roleId" = r."id"
    JOIN "permissions" p ON p."id" = rp."permissionId"
    WHERE m."tenantId" = ${scope.tenantId} AND m."userId" = ${scope.actorId}
    FOR SHARE OF m, r, rp, p
  `);
  const ability = createMongoAbility<AppAbility>(
    grants.map(({ action, subject }) => ({
      action: action as AppAbility['rules'][number]['action'],
      subject: subject as AppAbility['rules'][number]['subject'],
    })),
  );
  if (
    !ability.can('read', 'InventoryJournal') ||
    (operation === 'ADJUST' && !ability.can('create', 'InventoryAdjustment'))
  )
    throw new InventoryContractError('FORBIDDEN');
  return { displayName: actors[0].name };
}

/** CLS principal for a request-level call outside any transaction. */
export function resolveInventoryPrincipal(
  cls: ClsService<TenantClsStore>,
  db: TenantPrismaService,
): InventoryPrincipal {
  const actorId = cls.get('userId');
  if (typeof actorId !== 'string' || !actorId.trim())
    throw new InventoryContractError('UNAUTHORIZED');
  const tenantId = cls.get('tenantId');
  if (
    typeof tenantId !== 'string' ||
    !tenantId.trim() ||
    db.getTenantId() !== tenantId
  )
    throw new InventoryContractError('FORBIDDEN');
  if (db.isInTransaction()) throw new InventoryContractError('INTERNAL_ERROR');
  return { actorId, tenantId };
}
