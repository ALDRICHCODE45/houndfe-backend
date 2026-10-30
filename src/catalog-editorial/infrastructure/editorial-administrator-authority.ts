import type { PrismaClient } from '@prisma/client';

/** Optional only for narrow legacy clients: absent global proof grants nothing. */
export type EditorialAdministratorClient = Partial<Pick<PrismaClient, 'role'>>;

/** Caller must first verify the current active actor using this same client. */
export async function hasGlobalEditorialAdministrator(
  prisma: EditorialAdministratorClient,
  actorId: string,
): Promise<boolean> {
  // Keep the persisted predicate aligned with AuthService.completeLogin.
  const role = await prisma.role?.findFirst({
    where: {
      tenantId: null,
      tenantMemberships: { some: { userId: actorId } },
      OR: [
        { isSystem: true, name: 'Super Admin' },
        {
          permissions: {
            some: { permission: { subject: 'all', action: 'manage' } },
          },
        },
      ],
    },
    select: { id: true },
  });
  return typeof role?.id === 'string' && role.id.length > 0;
}
