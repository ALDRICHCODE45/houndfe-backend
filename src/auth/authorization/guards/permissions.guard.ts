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
 *
 * delivery-routes / WU2 — Subject-instance condition evaluation
 * (design ADR-5). The base guard evaluates `ability.can(action,
 * subject)` with a string subject; CASL does NOT evaluate rule
 * conditions against string subjects, so a `can('read',
 * 'DeliveryRoute', { driverUserId })` rule would silently pass for any
 * route. The guard gains a backward-compatible step:
 *
 *   1. Build the CASL ability (unchanged).
 *   2. Run the existing coarse `ability.can(action, subject)` loop
 *      with a string subject (still gates "does the user hold the
 *      permission at all").
 *   3. When `request.params.id` is present AND a resolver is registered
 *      for the requested subject (via `SUBJECT_INSTANCE_RESOLVERS`),
 *      resolve the subject instance and re-check
 *      `ability.can(action, subject('DeliveryRoute', { driverUserId }))`
 *      using the `@casl/ability` `subject()` helper so CASL evaluates
 *      the rule condition against a typed subject. Throw
 *      `InsufficientPermissionsError` on false; defer on null.
 *
 * The guard also attaches `request.ability` (backward-compatible
 * addition) so the service layer can perform list-scope filtering
 * (driver-only vs route-manager discriminator).
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { subject as caslSubject } from '@casl/ability';
import { CaslAbilityFactory } from '../casl-ability.factory';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { SubjectInstanceResolverRegistry } from '../subject-instance-resolver';
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

    // delivery-routes / WU2 — attach the built ability to the request so
    // the service layer can perform list-scope filtering
    // (`request.ability.can('create', 'DeliveryRoute')`). Backward-
    // compatible: existing code paths ignore the field.
    (request as unknown as { ability: typeof ability }).ability = ability;

    // 6. Check each required permission
    for (const [action, subject] of requiredPermissions) {
      // 6a. Coarse check — same as before WU2. A string subject is
      //     sufficient to gate "does the user hold the permission at
      //     all" (CASL ignores conditions for string subjects, which
      //     is exactly the gap ADR-5 fixes in the next step).
      if (!ability.can(action, subject)) {
        // User lacks this permission → 403
        throw new InsufficientPermissionsError();
      }

      // 6b. delivery-routes / WU2 — instance-scoped subject condition
      //     evaluation. Only fires when `request.params.id` is present
      //     AND a resolver is registered for the subject. When the
      //     resolver returns null (cross-tenant / missing) the guard
      //     defers — the service layer returns the proper 404.
      const resolver = SubjectInstanceResolverRegistry.get(subject);
      if (!resolver) {
        continue;
      }
      const params = (request.params ?? {}) as Record<string, unknown>;
      const id = typeof params.id === 'string' ? params.id : null;
      if (!id) {
        continue;
      }
      const instance = await resolver.resolveSubject(request);
      if (instance === null) {
        // Defer to the service's 404 (do not throw on miss; the guard
        // is not an existence oracle).
        continue;
      }
      const typedSubject = caslSubject(subject, instance);
      // CASL 6 evaluates rule conditions ONLY when the subject is a
      // tagged object (string subjects short-circuit condition
      // matching), so the re-check passes the tagged instance. The
      // cast is a type-only bridge: the ability's `can` overload
      // accepts `AppSubjects`, while `subject()` returns the tagged
      // object; runtime behavior is unchanged (the tag drives
      // `detectSubjectType` and the conditions matcher evaluates the
      // `{ driverUserId }` mongo query against the instance).
      if (!ability.can(action, typedSubject as unknown as AppSubjects)) {
        throw new InsufficientPermissionsError();
      }
    }

    // 7. All permissions present → allow
    return true;
  }
}
