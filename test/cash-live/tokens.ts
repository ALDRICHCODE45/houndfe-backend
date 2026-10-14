/**
 * cash-live harness — JWT signing for fictional actors.
 *
 * Signs the PRODUCTION final payload shape (validated by
 * `isFinalJwtPayload` in the real JwtStrategy):
 *   { sub, email, tenantId, tenantSlug, isSuperAdmin: false }
 *
 * No refresh tokens, no OTPs. Tokens are returned in-memory only and are
 * NEVER logged — every log path in the harness prints messages, never
 * token objects.
 */
import type { JwtService } from '@nestjs/jwt';
import type ms from 'ms';
import type { JwtTokenPayload } from '../../src/auth/interfaces/jwt-payload.interface';
import type { SeedResult } from './seed';
import type { LiveHarnessConfig } from './live-config';

export interface ActorTokens {
  cashier: string;
  verifier: string;
  foreign: string;
}

function signOne(
  jwtService: JwtService,
  user: SeedResult['users'][keyof SeedResult['users']],
  seed: SeedResult,
  config: LiveHarnessConfig,
): string {
  const tenant = seed.tenants.find((t) => t.id === user.tenantId);
  if (!tenant) {
    throw new Error(`Seeded tenant missing for actor ${user.functionalRole}`);
  }
  const payload: JwtTokenPayload = {
    sub: user.id,
    email: user.email,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    isSuperAdmin: false,
  };
  return jwtService.sign(payload, {
    secret: config.jwtSecret,
    expiresIn: config.accessTokenExpiresIn as ms.StringValue,
  });
}

/** Sign an access token per fictional actor. Never logs token material. */
export function signActorTokens(
  jwtService: JwtService,
  seed: SeedResult,
  config: LiveHarnessConfig,
): ActorTokens {
  return {
    cashier: signOne(jwtService, seed.users.cashier, seed, config),
    verifier: signOne(jwtService, seed.users.verifier, seed, config),
    foreign: signOne(jwtService, seed.users.foreign, seed, config),
  };
}
