/**
 * JWT Strategy - Passport strategy for validating access tokens.
 *
 * Extracts JWT from Authorization header and validates it.
 * On success, attaches user payload to request.user.
 *
 * validate() returns AuthenticatedUser which is what
 * @CurrentUser() decorator extracts from request.user.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type {
  JwtTokenPayload,
  AuthenticatedUser,
} from '../../interfaces/jwt-payload.interface';

export function isFinalJwtPayload(
  payload: unknown,
): payload is JwtTokenPayload {
  if (!payload || typeof payload !== 'object') return false;
  const claims = payload as Record<string, unknown>;
  return (
    claims.purpose === undefined &&
    typeof claims.sub === 'string' &&
    claims.sub.trim().length > 0 &&
    typeof claims.email === 'string' &&
    claims.email.trim().length > 0 &&
    (claims.tenantId === null || typeof claims.tenantId === 'string') &&
    (claims.tenantSlug === null || typeof claims.tenantSlug === 'string') &&
    typeof claims.isSuperAdmin === 'boolean'
  );
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: unknown): AuthenticatedUser {
    if (!isFinalJwtPayload(payload)) throw new UnauthorizedException();
    return {
      userId: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      tenantSlug: payload.tenantSlug,
      isSuperAdmin: payload.isSuperAdmin,
    };
  }
}
