/**
 * editorial-live harness — token claims (offline, in-memory secret).
 *
 * Signs with the real `JwtService` and validates with the real
 * `isFinalJwtPayload` / `JwtStrategy` mapping so every actor token is the
 * production final payload shape. Tokens are never printed.
 */
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import {
  JwtStrategy,
  isFinalJwtPayload,
} from '../../src/auth/infrastructure/strategies/jwt.strategy';
import { buildActorClaims, signEditorialActorTokens } from './tokens';
import { EDITORIAL_ACTOR_KEYS, type EditorialSeedResult } from './seed';
import { syntheticSeed } from './seed-result.fixture';

const secret = 'editorial-live-spec-secret-0123456789abcdef';
const config = {
  jwtSecret: secret,
  accessTokenExpiresIn: '7200s',
  accessTokenTtlSeconds: 7200,
};

describe('editorial-live actor claims', () => {
  const seed: EditorialSeedResult = syntheticSeed();

  it('global Super Admin: tenantId null, tenantSlug null, isSuperAdmin true', () => {
    expect(buildActorClaims(seed.actors['superadmin-global'])).toEqual({
      sub: seed.actors['superadmin-global'].userId,
      email: seed.actors['superadmin-global'].email,
      tenantId: null,
      tenantSlug: null,
      isSuperAdmin: true,
    });
  });

  it('Super Admin with tenant A selected: isSuperAdmin true, tenant A', () => {
    expect(buildActorClaims(seed.actors['superadmin-tenant'])).toEqual({
      sub: seed.actors['superadmin-tenant'].userId,
      email: seed.actors['superadmin-tenant'].email,
      tenantId: seed.tenants.a.id,
      tenantSlug: seed.tenants.a.slug,
      isSuperAdmin: true,
    });
  });

  it.each(['manage-all', 'editorial-only'] as const)(
    '%s: tenant A, isSuperAdmin false',
    (key) => {
      expect(buildActorClaims(seed.actors[key])).toEqual({
        sub: seed.actors[key].userId,
        email: seed.actors[key].email,
        tenantId: seed.tenants.a.id,
        tenantSlug: seed.tenants.a.slug,
        isSuperAdmin: false,
      });
    },
  );

  it('fails closed for a tenantless actor that is not a Super Admin', () => {
    expect(() =>
      buildActorClaims({
        ...seed.actors['manage-all'],
        selectedTenant: null,
      }),
    ).toThrow();
  });

  it('signs one production-shaped token per actor, accepted by the real JwtStrategy', () => {
    const jwt = new JwtService({ secret });
    const tokens = signEditorialActorTokens(jwt, seed, config);
    expect(Object.keys(tokens).sort()).toEqual(
      [...EDITORIAL_ACTOR_KEYS].sort(),
    );
    const strategy = new JwtStrategy({
      getOrThrow: () => secret,
    } as unknown as ConfigService);
    for (const key of EDITORIAL_ACTOR_KEYS) {
      const payload: unknown = jwt.verify(tokens[key], { secret });
      expect(isFinalJwtPayload(payload)).toBe(true);
      const claims = payload as Record<string, unknown>;
      expect(Object.keys(claims).sort()).toEqual(
        [
          'email',
          'exp',
          'iat',
          'isSuperAdmin',
          'sub',
          'tenantId',
          'tenantSlug',
        ].sort(),
      );
      expect((claims.exp as number) - (claims.iat as number)).toBe(7200);
      expect(strategy.validate(payload)).toEqual({
        userId: seed.actors[key].userId,
        email: seed.actors[key].email,
        tenantId: seed.actors[key].selectedTenant?.id ?? null,
        tenantSlug: seed.actors[key].selectedTenant?.slug ?? null,
        isSuperAdmin: seed.actors[key].isSuperAdmin,
      });
    }
    expect(() => {
      jwt.verify(tokens['superadmin-global'], { secret: 'x'.repeat(40) });
    }).toThrow();
    expect(new Set(Object.values(tokens)).size).toBe(4);
  });
});
