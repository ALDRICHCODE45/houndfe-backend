/**
 * Re-checks a stream's recipient against the database (unit 8; contract §5.3,
 * §10.1 R5): the user exists and is active (like `ActiveUserGuard`), still has
 * a membership in the tenant, and the ability built from the CURRENT
 * memberships still allows `read:ChatbotRequest`. The same factory as the
 * `PermissionsGuard`, so the stream can never be more permissive than the REST
 * routes. A lookup failure throws: it is never read as "revoked" (and never as
 * "allowed").
 */
import { Injectable } from '@nestjs/common';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { AccessPort, AccessResult } from '../application/realtime-access';

@Injectable()
export class PrismaRealtimeAccess implements AccessPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: CaslAbilityFactory,
  ) {}

  async check(tenantId: string, userId: string): Promise<AccessResult> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        tenantMemberships: {
          where: { tenantId },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!account || account.isActive !== true) {
      return { ok: false, reason: 'USER_INACTIVE' };
    }
    if (account.tenantMemberships.length === 0) {
      return { ok: false, reason: 'MEMBERSHIP_REMOVED' };
    }
    const ability = await this.abilities.createForUser(userId, {
      tenantId,
      isSuperAdmin: false,
    });
    if (!ability.can('read', 'ChatbotRequest')) {
      return { ok: false, reason: 'PERMISSION_REVOKED' };
    }
    return { ok: true, ability };
  }
}
