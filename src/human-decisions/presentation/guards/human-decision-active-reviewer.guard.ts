/**
 * HD-04d1 — HumanDecisionActiveReviewerGuard (route-scoped admission).
 *
 * Why this exists: the global `JwtStrategy.validate` only copies the signed
 * claims, and `CaslAbilityFactory` builds permissions from the TenantMembership
 * chain — neither re-checks the current `User` row. A still-valid access token
 * for a deactivated/deleted User would therefore still satisfy
 * `read/update:HumanDecision` and could read this tenant-confidential inbox.
 *
 * human-intervention / T1 generalized it into the shared `ActiveUserGuard`
 * (`src/auth/guards/active-user.guard.ts`). This subclass keeps the HD-04d1
 * contract unchanged for the human reviewer controller:
 *   - Missing/unusable `request.user.userId`      -> 401 UnauthorizedException.
 *   - Empty/null `request.user.tenantId`          -> 403 ForbiddenException.
 *   - `User` absent or `isActive !== true`        -> 401 UnauthorizedException.
 *   - Otherwise -> allow. The lookup selects ONLY `isActive`; there is no
 *     membership re-check here (a removed member already gets an empty CASL
 *     ability from `PermissionsGuard`). New routes use `ActiveUserGuard`.
 *
 * It runs AFTER `JwtAuthGuard` and `TenantContextGuard`, BEFORE
 * `PermissionsGuard`. This is a request-admission check; it does NOT claim
 * atomic revocation-vs-in-flight-read semantics.
 */
import { Injectable } from '@nestjs/common';
import { ActiveUserGuard } from '../../../auth/guards/active-user.guard';

@Injectable()
export class HumanDecisionActiveReviewerGuard extends ActiveUserGuard {
  protected override requiresTenantMembership(): boolean {
    return false;
  }
}
