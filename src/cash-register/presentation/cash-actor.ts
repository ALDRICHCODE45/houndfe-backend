/**
 * CASH ACTOR ADAPTER: cash-register presentation (T3/S3,S8).
 *
 * The application port expects a `CashActor { userId, ability }`. Both parts
 * are derived exclusively from trusted request state:
 *   - `userId` from `@CurrentUser()` (the verified JWT payload), and
 *   - `ability` from `request.ability`, which the REAL `PermissionsGuard`
 *     attaches after building the CASL ability for that user.
 *
 * A route without an attached ability fails closed with 403 instead of
 * degrading to an unauthenticated or role-name-derived actor; the controller
 * never reads a user id, tenant id, ability or command kind from the request
 * body.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { CashActor } from '../cash-application.port';

/** Request augmented by `PermissionsGuard` with the built CASL ability. */
export type CashRequestWithAbility = Request & { ability?: AppAbility };

/**
 * Build the trusted cash actor or fail closed. The application still rechecks
 * tenant, ownership, state and receiver scope; this helper only guarantees the
 * actor identity/authority inputs are trustworthy.
 */
export function requireCashActor(
  user: AuthenticatedUser,
  request: CashRequestWithAbility,
): CashActor {
  const ability = request.ability;
  if (!ability) {
    throw new ForbiddenException('Missing authorization ability');
  }
  return { userId: user.userId, ability };
}
