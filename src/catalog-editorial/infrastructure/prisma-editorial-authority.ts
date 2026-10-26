import type { PrismaClient } from '@prisma/client';
import type {
  EditorialContext,
  EditorialReadAuthority,
  ReadAuthoritySnapshot,
} from '../application/catalog-editorial-core';
import { EDITORIAL_PERMISSIONS } from '../domain/editorial-permissions';

/** Current actor/tenant/Product capability observation, not document authority. */
export interface EditorialCapabilitySnapshot extends ReadAuthoritySnapshot {
  canCreate: boolean;
  canSave: boolean;
}

/** Internal trusted-principal boundary; does not verify HTTP/JWT context. */
export class PrismaEditorialAuthority implements EditorialReadAuthority {
  constructor(
    private readonly prisma: Pick<
      PrismaClient,
      'user' | 'tenantMembership' | 'product'
    >,
  ) {}

  async resolve(
    context: EditorialContext,
  ): Promise<EditorialCapabilitySnapshot | null> {
    try {
      // Capture only qualification fields before any await, never caller flags.
      const { actorId, tenantId, productId } = context;
      if (
        [actorId, tenantId, productId].some(
          (id) => typeof id !== 'string' || id.trim().length === 0,
        )
      )
        return null;
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { isActive: true },
      });
      if (actor?.isActive !== true) return null;
      const memberships = await this.prisma.tenantMembership.findMany({
        where: { userId: actorId, tenantId },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });
      if (
        memberships.length === 0 ||
        memberships.some((m) => m.userId !== actorId || m.tenantId !== tenantId)
      )
        return null;
      const product = await this.prisma.product.findFirst({
        where: { id: productId, tenantId },
        select: { id: true, tenantId: true },
      });
      if (product?.id !== productId || product.tenantId !== tenantId)
        return null;
      const permissions = memberships.flatMap((m) =>
        m.role.permissions.map((row) => row.permission),
      );
      const has = (identity: { subject: string; action: string }) =>
        permissions.some(
          (p) => p.subject === identity.subject && p.action === identity.action,
        );
      const canEdit = has(EDITORIAL_PERMISSIONS.update);
      return {
        actorId,
        tenantId,
        productId,
        activeMember: true,
        canRead: has(EDITORIAL_PERMISSIONS.read),
        canCreate: canEdit,
        canSave: canEdit,
      };
    } catch {
      // Unavailable authority never becomes an effective grant or leaks errors.
      return null;
    }
  }
}
