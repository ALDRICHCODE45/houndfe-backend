/**
 * PermissionsGuard - Enforces permission-based authorization.
 *
 * Guard that runs AFTER JwtAuthGuard (assumes request.user exists).
 * Checks if the authenticated user has the required permissions
 * specified via @RequirePermissions decorator.
 *
 * EXECUTION ORDER:
 * 1. JwtAuthGuard validates JWT → sets request.user
 * 2. PermissionsGuard (this) → checks permissions
 *
 * BEHAVIOR:
 * - No metadata → allow (route doesn't require permissions)
 * - No user → throw UnauthorizedException (should never happen after JwtAuthGuard)
 * - Missing permission → throw InsufficientPermissionsError → 403
 * - All permissions present → allow
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CaslAbilityFactory } from '../casl-ability.factory';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { InsufficientPermissionsError } from '../../../shared/domain/domain-error';
import type { AuthenticatedUser } from '../../interfaces/jwt-payload.interface';
import type { AppActions, AppSubjects } from '../domain/permission';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Get required permissions from decorator metadata
    const requiredPermissions = this.reflector.getAllAndOverride<
      Array<[AppActions, AppSubjects]>
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // 2. If no permissions required on this route → allow
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // 3. Get authenticated user from request (set by JwtAuthGuard)
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    // 4. If no user → unauthorized (should never happen after JwtAuthGuard)
    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }

    // 5. Build CASL ability for this user
    const ability = await this.caslAbilityFactory.createForUser(user.userId, {
      tenantId: user.tenantId,
      isSuperAdmin: user.isSuperAdmin,
    });

    // 6. Check each required permission
    for (const [action, subject] of requiredPermissions) {
      if (!ability.can(action, subject)) {
        // User lacks this permission → 403
        throw new InsufficientPermissionsError();
      }
    }

    // 7. All permissions present → allow
    return true;
  }
}
