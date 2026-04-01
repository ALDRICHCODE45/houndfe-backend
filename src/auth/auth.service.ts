/**
 * AuthService - Application layer (Use Cases).
 *
 * Orchestrates authentication domain logic and infrastructure.
 *
 * RESPONSIBILITIES:
 * - Receive DTOs from controller
 * - Translate to domain operations
 * - Coordinate with repository and JWT service
 * - Return results
 *
 * DOES NOT contain business logic (that's in User entity and VOs).
 */
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import type { IUserRepository } from './domain/user.repository';
import { USER_REPOSITORY } from './domain/user.repository';
import { User } from './domain/user.entity';
import { Email } from './domain/value-objects/email.value-object';
import { HashedPassword } from './domain/value-objects/hashed-password.value-object';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  InvalidCredentialsError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
} from '../shared/domain/domain-error';
import type { JwtTokenPayload } from './interfaces/jwt-payload.interface';
import type ms from 'ms';
import {
  CaslAbilityFactory,
  type EffectivePermission,
} from './authorization/casl-ability.factory';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: ReturnType<User['toResponse']>;
}

export interface UserPermissionsResponse {
  permissions: EffectivePermission[];
  permissionCodes: string[];
}

/** Bcrypt salt rounds for refresh token hashing. */
const REFRESH_TOKEN_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY)
    private readonly userRepo: IUserRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = Email.create(dto.email);

    const exists = await this.userRepo.existsByEmail(email);
    if (exists) throw new EntityAlreadyExistsError('User', dto.email);

    const hashedPassword = await HashedPassword.fromPlain(dto.password);

    const user = User.create({
      id: crypto.randomUUID(),
      email,
      hashedPassword,
      name: dto.name,
    });

    const saved = await this.userRepo.save(user);
    const tokens = await this.generateTokens(saved.id, saved.email.value);
    await this.updateRefreshTokenHash(saved.id, tokens.refreshToken);

    return {
      ...tokens,
      user: saved.toResponse(),
    };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = Email.create(dto.email);
    const user = await this.userRepo.findByEmail(email);

    if (!user) throw new InvalidCredentialsError();

    const isPasswordValid = await user.hashedPassword.compare(dto.password);
    if (!isPasswordValid) throw new InvalidCredentialsError();

    if (!user.isActive) {
      throw new InvalidCredentialsError(); // Don't reveal account is deactivated
    }

    const tokens = await this.generateTokens(user.id, user.email.value);
    await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

    return {
      ...tokens,
      user: user.toResponse(),
    };
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtTokenPayload>(
        refreshToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        },
      );
    } catch {
      throw new InvalidCredentialsError();
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user || !user.hashedRefreshToken) {
      throw new InvalidCredentialsError();
    }

    const isValid = await bcrypt.compare(refreshToken, user.hashedRefreshToken);
    if (!isValid) throw new InvalidCredentialsError();

    const tokens = await this.generateTokens(user.id, user.email.value);
    await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);

    user.clearRefreshToken();
    await this.userRepo.save(user);
  }

  async getProfile(userId: string): Promise<ReturnType<User['toResponse']>> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);
    return user.toResponse();
  }

  async getUserPermissions(userId: string): Promise<UserPermissionsResponse> {
    const permissions =
      await this.caslAbilityFactory.getEffectivePermissions(userId);

    if (!permissions) throw new EntityNotFoundError('User', userId);

    const permissionCodes = permissions.map((p) => `${p.action}:${p.subject}`);

    return { permissions, permissionCodes };
  }

  private async generateTokens(
    userId: string,
    email: string,
  ): Promise<AuthTokens> {
    const payload: JwtTokenPayload = { sub: userId, email };

    const accessExpiration = this.configService.get<ms.StringValue>(
      'JWT_ACCESS_EXPIRATION',
      '15m',
    );
    const refreshExpiration = this.configService.get<ms.StringValue>(
      'JWT_REFRESH_EXPIRATION',
      '7d',
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: accessExpiration,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiration,
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async updateRefreshTokenHash(
    userId: string,
    refreshToken: string,
  ): Promise<void> {
    const hash = await bcrypt.hash(refreshToken, REFRESH_TOKEN_SALT_ROUNDS);
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);

    user.updateRefreshToken(hash);
    await this.userRepo.save(user);
  }
}
