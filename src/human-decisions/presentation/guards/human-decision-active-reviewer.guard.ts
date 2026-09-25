/**
 * HD-04d1 — HumanDecisionActiveReviewerGuard (route-scoped admission).
 *
 * Why this exists: the global `JwtStrategy.validate` only copies the signed
 * claims, and `CaslAbilityFactory` builds permissions from the TenantMembership
 * chain — neither re-checks the current `User` row. A still-valid access token
 * for a deactivated/deleted User would therefore still satisfy
 * `read/update:HumanDecision` and could read this tenant-confidential inbox.
 *
 * This guard closes that gap at request admission for the human reviewer
 * controller only. It runs AFTER `JwtAuthGuard` (so `request.user` is the
 * verified JWT principal) and AFTER `TenantContextGuard`, but BEFORE
 * `PermissionsGuard` (so no CASL ability is built for a revoked account).
 *
 * Contract:
 *   - Missing/unusable `request.user.userId`      -> 401 UnauthorizedException.
 *   - Empty/null `request.user.tenantId`          -> 403 ForbiddenException.
 *     (Defense in depth: the controller's own tenant gate stays in place; a
 *     tenantless global superadmin must never reach the tenant-scoped read.)
 *   - `User` absent or `isActive !== true`        -> 401 UnauthorizedException.
 *   - Otherwise -> allow, and NO tenant/actor authority is taken from the
 *     client (the id comes from the verified JWT principal only).
 *
 * The lookup selects ONLY `isActive` and uses the root `PrismaService` (never
 * `TenantPrismaService`): admission is account-scoped, and a tenantless
 * principal is rejected before the query. This is a request-admission check; it
 * does NOT claim atomic revocation-vs-in-flight-read semantics, and HD-04d2
 * owns the real DB/ALS proof.
 *
 * No shared guard, strategy, adapter, schema, controller or bot path is
 * modified by this file.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../../auth/interfaces/jwt-payload.interface';
import { PrismaService } from '../../../shared/prisma/prisma.service';

/** Express request shaped by `JwtAuthGuard` / `TenantContextGuard`. */
interface ActiveReviewerRequest extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class HumanDecisionActiveReviewerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ActiveReviewerRequest>();
    const user = request.user;

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

    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isActive: true },
    });

    if (!account || account.isActive !== true) {
      throw new UnauthorizedException('User is inactive or not found');
    }

    return true;
  }
}
