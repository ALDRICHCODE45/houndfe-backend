/**
 * human-intervention / T1 (contract v1 §2.5, §10.1 R5) — ActiveUserGuard.
 *
 * Generalizes HD-04d1's `HumanDecisionActiveReviewerGuard`. The global
 * `JwtStrategy.validate` only copies the signed claims and access tokens live
 * 15 min, so a deactivated user, or one removed from the tenant, would keep
 * passing `JwtAuthGuard` until the token expires. This guard re-checks the
 * current rows on every request.
 *
 * Order: `JwtAuthGuard → TenantContextGuard → ActiveUserGuard →
 * PermissionsGuard`, so no CASL ability is built for a revoked account.
 *
 * Contract (fail closed; a lookup error propagates as a 500, never a pass):
 *   - Missing/unusable `request.user.userId`        -> 401.
 *   - Empty/null `request.user.tenantId`            -> 403 (tenant routes only;
 *     a tenantless global super admin never reaches them).
 *   - `User` absent or `isActive !== true`          -> 401.
 *   - No `TenantMembership` in the token's tenant   -> 403. Applies to super
 *     admins acting in a tenant too: their tenant ability already comes from
 *     the membership chain (`CaslAbilityFactory`).
 *
 * One Prisma call on the root `PrismaService` (admission is account-scoped,
 * not tenant-scoped data), selecting only `isActive` and one membership id.
 * Without `relationJoins` it runs as two indexed SQL statements.
 * Ids come from the verified JWT principal only.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';

/** Express request shaped by `JwtAuthGuard` / `TenantContextGuard`. */
interface ActiveUserRequest extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(protected readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<ActiveUserRequest>().user;

    if (
      !user ||
      typeof user.userId !== 'string' ||
      user.userId.trim().length === 0
    ) {
      throw new UnauthorizedException('Authenticated user required');
    }

    if (
      typeof user.tenantId !== 'string' ||
      user.tenantId.trim().length === 0
    ) {
      throw new ForbiddenException('Tenant context required');
    }

    if (!this.requiresTenantMembership()) {
      const account = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: { isActive: true },
      });
      if (!account || account.isActive !== true) {
        throw new UnauthorizedException('User is inactive or not found');
      }
      return true;
    }

    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        isActive: true,
        tenantMemberships: {
          where: { tenantId: user.tenantId },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!account || account.isActive !== true) {
      throw new UnauthorizedException('User is inactive or not found');
    }

    if (account.tenantMemberships.length === 0) {
      throw new ForbiddenException('Tenant membership required');
    }

    return true;
  }

  /**
   * Whether the current tenant membership is re-checked. Only the legacy
   * human-decision reviewer guard opts out, to keep its HD-04d1 contract.
   */
  protected requiresTenantMembership(): boolean {
    return true;
  }
}
