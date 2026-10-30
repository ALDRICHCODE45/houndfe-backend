import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { hasGlobalEditorialAdministrator } from './editorial-administrator-authority';

/** Resolve global HTTP mode only; concrete scopes retain downstream authority checks. */
export class EditorialHttpScope {
  constructor(
    private readonly prisma: Pick<PrismaClient, 'user' | 'role' | 'product'>,
  ) {}

  principal(user: AuthenticatedUser | undefined): AuthenticatedUser {
    if (
      !user?.userId?.trim() ||
      (user.tenantId === null
        ? user.isSuperAdmin !== true
        : !user.tenantId?.trim())
    )
      throw new ForbiddenException();
    return user;
  }

  async product(user: AuthenticatedUser, productId: string) {
    const { userId: actorId, tenantId } = this.principal(user);
    if (tenantId !== null) return { actorId, tenantId, productId };
    try {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { isActive: true },
      });
      if (
        actor?.isActive !== true ||
        !(await hasGlobalEditorialAdministrator(this.prisma, actorId))
      )
        throw new ForbiddenException();
      const product = await this.prisma.product.findFirst({
        where: { id: productId },
        select: { id: true, tenantId: true },
      });
      if (product?.id !== productId || !product.tenantId?.trim())
        throw new ForbiddenException();
      return { actorId, tenantId: product.tenantId, productId };
    } catch {
      throw new ForbiddenException();
    }
  }
}
