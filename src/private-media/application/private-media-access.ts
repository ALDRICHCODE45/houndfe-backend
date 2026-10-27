import type { PrismaClient } from '@prisma/client';
import { PrismaEditorialAuthority } from '../../catalog-editorial/infrastructure/prisma-editorial-authority';
export interface PrivateMediaContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly productId: string;
}
/** Trusted internal identity only; never accepts caller-provided grants. */
export class PrivateMediaAccess {
  private readonly authority: PrismaEditorialAuthority;
  constructor(
    prisma: Pick<PrismaClient, 'user' | 'tenantMembership' | 'product'>,
  ) {
    this.authority = new PrismaEditorialAuthority(prisma);
  }
  canUpload(context: PrivateMediaContext): Promise<boolean> {
    return this.permits(context, true);
  }
  canRead(context: PrivateMediaContext): Promise<boolean> {
    return this.permits(context, false);
  }
  private async permits(
    context: PrivateMediaContext,
    upload: boolean,
  ): Promise<boolean> {
    try {
      const { actorId, tenantId, productId } = context;
      if (
        [actorId, tenantId, productId].some(
          (id) => typeof id !== 'string' || id.trim().length === 0,
        )
      )
        return false;
      const snapshot = await this.authority.resolve({
        actorId,
        tenantId,
        productId,
      });
      return (
        snapshot?.actorId === actorId &&
        snapshot.tenantId === tenantId &&
        snapshot.productId === productId &&
        snapshot.activeMember === true &&
        snapshot.canRead === true &&
        (!upload || snapshot.canSave === true)
      );
    } catch {
      return false;
    }
  }
}
