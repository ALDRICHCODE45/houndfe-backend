import { Prisma } from '@prisma/client';
import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { SupplierContractError } from './supplier-contract';

export interface SupplierPrincipal {
  actorId: string;
  tenantId: string;
}

/** Only called on the command's owned transaction, after lifecycle and Tenant locks. */
export async function requireSupplierAuthority(
  tx: Prisma.TransactionClient,
  scope: SupplierPrincipal,
  operation: 'CREATE' | 'UPDATE',
): Promise<void> {
  const actors = await tx.$queryRaw<
    { id: string; isActive: boolean }[]
  >(Prisma.sql`
    SELECT u."id", u."isActive" FROM "users" u
    WHERE u."id" = ${scope.actorId} FOR SHARE OF u
  `);
  if (actors[0]?.id !== scope.actorId || actors[0].isActive !== true)
    throw new SupplierContractError('UNAUTHORIZED');

  // Membership has no active flag: persisted presence is current membership.
  // SHARE locks cover the actual grant edges, not just Role. assignPermissions
  // deletes role_permissions without locking Role first; those deletes must wait.
  // New grant gaps need not be locked: absence denies, never authorizes.
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
  // Same CASL action/subject implication as the ordinary factory, including
  // manage:all. No super-admin claim/global-role or editorial-specific bypass.
  const ability = createMongoAbility<AppAbility>(
    grants.map(({ action, subject }) => ({
      action: action as AppAbility['rules'][number]['action'],
      subject: subject as AppAbility['rules'][number]['subject'],
    })),
  );
  if (
    !ability.can(
      operation === 'CREATE' ? 'create' : 'update',
      'ProcurementSupplier',
    ) ||
    (operation === 'UPDATE' && !ability.can('read', 'ProcurementSupplier'))
  )
    throw new SupplierContractError('FORBIDDEN');
}
