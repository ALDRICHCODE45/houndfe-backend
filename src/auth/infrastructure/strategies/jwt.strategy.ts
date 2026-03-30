/**
 * JWT Strategy - Passport strategy for validating access tokens.
 *
 * Extracts JWT from Authorization header and validates it.
 * On success, attaches user payload to request.user.
 *
 * validate() returns AuthenticatedUser which is what
 * @CurrentUser() decorator extracts from request.user.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type {
  JwtTokenPayload,
  AuthenticatedUser,
} from '../../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtTokenPayload): AuthenticatedUser {
    return { userId: payload.sub, email: payload.email };
  }
}
