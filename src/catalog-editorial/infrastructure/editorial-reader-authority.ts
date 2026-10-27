import type { PrismaClient } from '@prisma/client';
import { EDITORIAL_PERMISSIONS } from '../domain/editorial-permissions';

/** Product-less H1 membership/permission checks; never a synthetic Product grant. */
export class EditorialReaderAuthority {
  constructor(
    private readonly prisma: Pick<PrismaClient, 'user' | 'tenantMembership'>,
  ) {}

  async permits(actorId: string, tenantId: string): Promise<boolean> {
    try {
      if (
        [actorId, tenantId].some((id) => typeof id !== 'string' || !id.trim())
      )
        return false;
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { isActive: true },
      });
      if (actor?.isActive !== true) return false;
      const memberships = await this.prisma.tenantMembership.findMany({
        where: { userId: actorId, tenantId },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });
      return (
        memberships.length > 0 &&
        memberships.every(
          (m) => m.userId === actorId && m.tenantId === tenantId,
        ) &&
        memberships.some((m) =>
          m.role.permissions.some(
            ({ permission: p }) =>
              p.subject === EDITORIAL_PERMISSIONS.read.subject &&
              p.action === EDITORIAL_PERMISSIONS.read.action,
          ),
        )
      );
    } catch {
      return false;
    }
  }
}
