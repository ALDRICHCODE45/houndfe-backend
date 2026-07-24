/**
 * BatchDeleteGuard - Strict explicit-permission check for batch_delete.
 *
 * Spec: batch-delete/spec.md R9, R10.
 *
 * WHY a dedicated guard:
 *   CASL's `manage` action implies every other action — so a normal
 *   `ability.can('batch_delete', 'Promotion')` check would wrongly let
 *   through any user with `manage:Promotion` (R10 violation). The
 *   `CaslAbilityFactory.getEffectivePermissions()` accessor returns the
 *   RAW DB rows without manage-implication, so we can scan them for an
 *   explicit `batch_delete:<subject>` tuple. Superadmins (`manage:all`
 *   in raw rows) bypass.
 *
 * METADATA:
 *   Reads the same `PERMISSIONS_KEY` set by `@RequirePermissions` so
 *   the route handler only needs one decorator. The guard filters
 *   tuples down to `[action === 'batch_delete']` and checks each
 *   `[subject]`.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppActions,
  AppSubjects,
} from '../../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../../auth/interfaces/jwt-payload.interface';
import {
  CaslAbilityFactory,
} from '../../../auth/authorization/casl-ability.factory';
import { InsufficientPermissionsError } from '../../domain/domain-error';

/**
 * Metadata key for the explicit batch-delete tuples this guard inspects.
 *
 * Defaults to `PERMISSIONS_KEY` so routes only need
 * `@RequirePermissions(['batch_delete', subject])` and the guard
 * pulls the same tuple. Exported in case a caller wants to override.
 */
export const BATCH_DELETE_GUARD_METADATA = PERMISSIONS_KEY;

@Injectable()
export class BatchDeleteGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Read route metadata (reuses the standard `@RequirePermissions` key).
    const required = this.reflector.getAllAndOverride<
      Array<[AppActions, AppSubjects]>
    >(BATCH_DELETE_GUARD_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 2. No metadata → route is unprotected by THIS guard (allow).
    if (!required || required.length === 0) {
      return true;
    }

    // 3. Pull the user (set by JwtAuthGuard earlier in the chain).
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }

    // 4. Resolve effective permissions (raw DB rows, no manage-implication).
    const effective =
      await this.caslAbilityFactory.getEffectivePermissions(user.userId, {
        tenantId: user.tenantId,
        isSuperAdmin: user.isSuperAdmin,
      });

    // null → user was not found. Treat as forbidden.
    if (effective === null) {
      throw new InsufficientPermissionsError();
    }

    // 5. Superadmin bypass: raw rows include [{ manage, 'all' }].
    //    Accept either `manage:all` or any `batch_delete:all` row.
    if (
      effective.some(
        (p) =>
          (p.action === 'manage' && p.subject === 'all') ||
          (p.action === 'batch_delete' && p.subject === 'all'),
      )
    ) {
      return true;
    }

    // 6. Inspect only the `batch_delete` tuples from the metadata.
    const batchDeleteTuples = required.filter(
      ([action]) => action === 'batch_delete',
    );

    // No batch_delete tuple declared → this guard has nothing to check.
    if (batchDeleteTuples.length === 0) {
      return true;
    }

    // 7. Each `[batch_delete, subject]` must be present as an explicit row.
    for (const [, subject] of batchDeleteTuples) {
      const allowed = effective.some(
        (p) => p.action === 'batch_delete' && p.subject === subject,
      );
      if (!allowed) {
        throw new InsufficientPermissionsError();
      }
    }

    return true;
  }
}