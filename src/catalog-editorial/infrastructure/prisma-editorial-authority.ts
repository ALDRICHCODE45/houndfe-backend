import type { PrismaClient } from '@prisma/client';
import type {
  EditorialContext,
  EditorialCreateAuthority,
  EditorialSaveAuthority,
  EditorialReadAuthority,
  ReadAuthoritySnapshot,
} from '../application/catalog-editorial-core';
import { EDITORIAL_PERMISSIONS } from '../domain/editorial-permissions';
import type { DocumentAuthority } from '../domain/document';

export interface EditorialDocumentAuthorityProvider {
  resolve(context: EditorialContext): Promise<DocumentAuthority | null>;
}

/** Current actor/tenant/Product capability observation, not document authority. */
export interface EditorialCapabilitySnapshot extends ReadAuthoritySnapshot {
  canCreate: boolean;
  canSave: boolean;
}

/** Internal trusted-principal boundary; does not verify HTTP/JWT context. */
export class PrismaEditorialAuthority implements EditorialReadAuthority {
  readonly createAuthority: EditorialCreateAuthority = {
    resolve: (context) => this.resolveWrite(context, 'canCreate'),
  };
  readonly saveAuthority: EditorialSaveAuthority = {
    resolve: (context) => this.resolveWrite(context, 'canSave'),
  };

  constructor(
    private readonly prisma: Pick<
      PrismaClient,
      'user' | 'tenantMembership' | 'product'
    >,
    private readonly documents?: EditorialDocumentAuthorityProvider,
  ) {}

  private async resolveWrite(
    context: EditorialContext,
    capability: 'canCreate' | 'canSave',
  ) {
    try {
      const { actorId, tenantId, productId } = context;
      const scope = { actorId, tenantId, productId };
      const access = await this.resolve(scope);
      if (!access?.canRead || !access[capability] || !this.documents)
        return null;
      const supplied = await this.documents.resolve({ ...scope });
      if (!supplied) return null;
      // Detach qualification and nested allowlists from provider-owned objects.
      const documentAuthority = structuredClone(supplied);
      if (
        documentAuthority.tenantId !== tenantId ||
        documentAuthority.productId !== productId
      )
        return null;
      return { ...access, documentAuthority };
    } catch {
      return null;
    }
  }

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
      const canRead = has(EDITORIAL_PERMISSIONS.read);
      const canEdit = canRead && has(EDITORIAL_PERMISSIONS.update);
      return {
        actorId,
        tenantId,
        productId,
        activeMember: true,
        canRead,
        canCreate: canEdit,
        canSave: canEdit,
      };
    } catch {
      // Unavailable authority never becomes an effective grant or leaks errors.
      return null;
    }
  }
}
