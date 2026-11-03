import { Prisma } from '@prisma/client';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PurchaseOrderContractError } from './po-contract';

export interface PurchaseOrderPrincipal {
  actorId: string;
  tenantId: string;
}

/** Owned transaction only, after lifecycle and Tenant SHARE locks. */
export async function requirePurchaseOrderAuthority(
  tx: Prisma.TransactionClient,
  scope: PurchaseOrderPrincipal,
  operation: 'CREATE' | 'REPLACE' | 'DELETE' | 'READ',
): Promise<void> {
  const actors = await tx.$queryRaw<
    { id: string; isActive: boolean }[]
  >(Prisma.sql`
    SELECT u."id", u."isActive" FROM "users" u
    WHERE u."id" = ${scope.actorId} FOR SHARE OF u
  `);
  if (actors[0]?.id !== scope.actorId || actors[0].isActive !== true)
    throw new PurchaseOrderContractError('UNAUTHORIZED');
  // Lock grant edges themselves: assignPermissions deletes them without a Role lock.
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
  const action =
    operation === 'CREATE'
      ? 'create'
      : operation === 'REPLACE'
        ? 'update'
        : operation === 'DELETE'
          ? 'delete'
          : 'read';
  if (
    !ability.can(action, 'ProcurementPurchaseOrder') ||
    (operation !== 'CREATE' &&
      !ability.can('read', 'ProcurementPurchaseOrder')) ||
    ((operation === 'CREATE' || operation === 'REPLACE') &&
      (!ability.can('read', 'ProcurementSupplier') ||
        !ability.can('read', 'Product')))
  )
    throw new PurchaseOrderContractError('FORBIDDEN');
}
