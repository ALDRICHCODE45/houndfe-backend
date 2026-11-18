/**
 * editorial-live harness — JWT signing for the four fictional actors.
 *
 * Production final payload shape (validated by the real JwtStrategy's
 * `isFinalJwtPayload`): { sub, email, tenantId, tenantSlug, isSuperAdmin }.
 * Unlike cash-live (always isSuperAdmin:false), isSuperAdmin follows the
 * actor: true for both Super Admin sessions (global: tenantId null; selected
 * tenant: tenant A, as AuthService.switchTenantAsSuperAdmin issues), false
 * otherwise. No refresh token, no OTP. Tokens stay in memory, never logged.
 */
import type { JwtService } from '@nestjs/jwt';
import type ms from 'ms';
import type { JwtTokenPayload } from '../../src/auth/interfaces/jwt-payload.interface';
import type { LiveHarnessConfig } from '../cash-live/live-config';
import {
  EDITORIAL_ACTOR_KEYS,
  type EditorialActorKey,
  type EditorialSeedResult,
  type SeededEditorialActor,
} from './seed';

export type EditorialActorTokens = Record<EditorialActorKey, string>;

/** Final claims for one actor. Fails closed for a tenantless non-admin. */
export function buildActorClaims(actor: SeededEditorialActor): JwtTokenPayload {
  if (actor.selectedTenant === null && actor.isSuperAdmin !== true) {
    throw new Error(
      `editorial-live: actor ${actor.key} has no tenant and is not a Super Admin`,
    );
  }
  return {
    sub: actor.userId,
    email: actor.email,
    tenantId: actor.selectedTenant?.id ?? null,
    tenantSlug: actor.selectedTenant?.slug ?? null,
    isSuperAdmin: actor.isSuperAdmin,
  };
}

/** Sign an access token per actor. Never logs token material. */
export function signEditorialActorTokens(
  jwtService: JwtService,
  seed: EditorialSeedResult,
  config: Pick<LiveHarnessConfig, 'jwtSecret' | 'accessTokenExpiresIn'>,
): EditorialActorTokens {
  const tokens = {} as EditorialActorTokens;
  for (const key of EDITORIAL_ACTOR_KEYS) {
    tokens[key] = jwtService.sign(buildActorClaims(seed.actors[key]), {
      secret: config.jwtSecret,
      expiresIn: config.accessTokenExpiresIn as ms.StringValue,
    });
  }
  return tokens;
}
