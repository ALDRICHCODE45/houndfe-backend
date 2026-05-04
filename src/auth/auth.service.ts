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
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
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
import { PrismaService } from '../shared/prisma/prisma.service';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import type { SelectTenantDto } from './dto/select-tenant.dto';
import type { SwitchTenantDto } from './dto/switch-tenant.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: ReturnType<User['toResponse']>;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
}

export interface LoginSuccessResponse extends AuthTokens {
  requiresTenantSelection: false;
  user: ReturnType<User['toResponse']>;
  tenants: TenantSummary[];
}

export interface LoginTenantSelectionResponse {
  requiresTenantSelection: true;
  user: ReturnType<User['toResponse']>;
  tenants: TenantSummary[];
  tempToken: string;
  expiresIn: 300;
}

export type LoginResponse = LoginSuccessResponse | LoginTenantSelectionResponse;

type AuthContext = {
  tenantId: string | null;
  tenantSlug: string | null;
  isSuperAdmin: boolean;
};

type TenantSelectionTokenPayload = {
  sub: string;
  email: string;
  purpose: 'tenant-selection';
};

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
    private readonly prisma: PrismaService,
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
    const tokens = await this.generateTokens(saved.id, saved.email.value, {
      tenantId: null,
      tenantSlug: null,
      isSuperAdmin: false,
    });
    await this.updateRefreshTokenHash(saved.id, tokens.refreshToken);

    return {
      ...tokens,
      user: saved.toResponse(),
    };
  }

  async login(dto: LoginDto): Promise<LoginResponse> {
    const email = Email.create(dto.email);
    const user = await this.userRepo.findByEmail(email);

    if (!user) throw new InvalidCredentialsError();

    const isPasswordValid = await user.hashedPassword.compare(dto.password);
    if (!isPasswordValid) throw new InvalidCredentialsError();

    if (!user.isActive) {
      throw new InvalidCredentialsError(); // Don't reveal account is deactivated
    }

    const memberships = await this.prisma.tenantMembership.findMany({
      where: { userId: user.id },
      include: {
        tenant: true,
        role: true,
      },
    });

    const activeMemberships = memberships.filter((m) => m.tenant.isActive);
    const tenants = activeMemberships.map((m) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
    }));

    const hasGlobalSuperAdminRole = await this.prisma.role.findFirst({
      where: {
        tenantId: null,
        tenantMemberships: {
          some: { userId: user.id },
        },
        OR: [
          { isSystem: true, name: 'Super Admin' },
          {
            permissions: {
              some: {
                permission: {
                  subject: 'all',
                  action: 'manage',
                },
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (hasGlobalSuperAdminRole) {
      const authContext: AuthContext = {
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
      };
      const tokens = await this.generateTokens(user.id, user.email.value, authContext);
      await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

      return {
        requiresTenantSelection: false,
        ...tokens,
        tenants,
        user: user.toResponse(),
      };
    }

    if (activeMemberships.length === 1) {
      const selected = activeMemberships[0];
      const authContext: AuthContext = {
        tenantId: selected.tenant.id,
        tenantSlug: selected.tenant.slug,
        isSuperAdmin: false,
      };
      const tokens = await this.generateTokens(user.id, user.email.value, authContext);
      await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

      return {
        requiresTenantSelection: false,
        ...tokens,
        tenants,
        user: user.toResponse(),
      };
    }

    if (activeMemberships.length > 1) {
      const tempToken = await this.generateTenantSelectionToken(
        user.id,
        user.email.value,
      );

      return {
        requiresTenantSelection: true,
        user: user.toResponse(),
        tenants,
        tempToken,
        expiresIn: 300,
      };
    }

    throw new ForbiddenException('User does not belong to an active tenant');
  }

  async selectTenant(dto: SelectTenantDto): Promise<AuthResponse> {
    const payload = await this.verifyTenantSelectionToken(dto.tempToken);

    const membership = await this.prisma.tenantMembership.findFirst({
      where: {
        userId: payload.sub,
        tenantId: dto.tenantId,
      },
      include: {
        tenant: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('User does not belong to the selected tenant');
    }

    if (!membership.tenant.isActive) {
      throw new ForbiddenException('Selected tenant is inactive');
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user) throw new InvalidCredentialsError();

    const authContext: AuthContext = {
      tenantId: membership.tenant.id,
      tenantSlug: membership.tenant.slug,
      isSuperAdmin: false,
    };

    const tokens = await this.generateTokens(user.id, user.email.value, authContext);
    await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

    return {
      ...tokens,
      user: user.toResponse(),
    };
  }

  async switchTenant(
    currentUser: AuthenticatedUser,
    dto: SwitchTenantDto,
  ): Promise<AuthTokens> {
    if (currentUser.isSuperAdmin) {
      return this.switchTenantAsSuperAdmin(currentUser, dto);
    }

    return this.switchTenantAsMember(currentUser, dto);
  }

  private async switchTenantAsSuperAdmin(
    currentUser: AuthenticatedUser,
    dto: SwitchTenantDto,
  ): Promise<AuthTokens> {
    let authContext: AuthContext;

    if (!dto.tenantId) {
      authContext = {
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
      };
    } else {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: dto.tenantId },
      });

      if (!tenant) throw new ForbiddenException('TENANT_NOT_FOUND');
      if (!tenant.isActive) throw new ForbiddenException('TENANT_INACTIVE');

      authContext = {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        isSuperAdmin: true,
      };
    }

    const tokens = await this.generateTokens(
      currentUser.userId,
      currentUser.email,
      authContext,
    );
    await this.updateRefreshTokenHash(currentUser.userId, tokens.refreshToken);

    return tokens;
  }

  private async switchTenantAsMember(
    currentUser: AuthenticatedUser,
    dto: SwitchTenantDto,
  ): Promise<AuthTokens> {
    if (!dto.tenantId) {
      throw new ForbiddenException('SUPER_ADMIN_REQUIRED');
    }

    const membership = await this.prisma.tenantMembership.findFirst({
      where: {
        userId: currentUser.userId,
        tenantId: dto.tenantId,
      },
      include: { tenant: true },
    });

    if (!membership) throw new ForbiddenException('TENANT_ACCESS_DENIED');
    if (!membership.tenant.isActive) throw new ForbiddenException('TENANT_INACTIVE');

    const authContext: AuthContext = {
      tenantId: membership.tenant.id,
      tenantSlug: membership.tenant.slug,
      isSuperAdmin: false,
    };

    const tokens = await this.generateTokens(
      currentUser.userId,
      currentUser.email,
      authContext,
    );
    await this.updateRefreshTokenHash(currentUser.userId, tokens.refreshToken);

    return tokens;
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

    const authContext: AuthContext = {
      tenantId: payload.tenantId,
      tenantSlug: payload.tenantSlug,
      isSuperAdmin: payload.isSuperAdmin,
    };

    const tokens = await this.generateTokens(user.id, user.email.value, authContext);
    await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);

    user.clearRefreshToken();
    await this.userRepo.save(user);
  }

  async getProfile(userId: string, tenantId?: string | null): Promise<{
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
    tenant: TenantSummary | null;
    memberships: TenantSummary[];
  }> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('User', userId);

    const memberships = await this.prisma.tenantMembership.findMany({
      where: { userId },
      include: { tenant: true },
    });

    const activeMemberships = memberships
      .filter((membership) => membership.tenant.isActive)
      .map((membership) => ({
        id: membership.tenant.id,
        name: membership.tenant.name,
        slug: membership.tenant.slug,
      }));

    const currentTenant =
      tenantId == null
        ? null
        : activeMemberships.find((membership) => membership.id === tenantId) ?? null;

    return {
      ...user.toResponse(),
      tenant: currentTenant,
      memberships: activeMemberships,
    };
  }

  async getUserPermissions(user: AuthenticatedUser): Promise<UserPermissionsResponse> {
    const permissions =
      await this.caslAbilityFactory.getEffectivePermissions(user.userId, {
        tenantId: user.tenantId,
        isSuperAdmin: user.isSuperAdmin,
      });

    if (!permissions) throw new EntityNotFoundError('User', user.userId);

    const permissionCodes = permissions.map((p) => `${p.action}:${p.subject}`);

    return { permissions, permissionCodes };
  }

  private async generateTokens(
    userId: string,
    email: string,
    authContext: AuthContext,
  ): Promise<AuthTokens> {
    const payload: JwtTokenPayload = {
      sub: userId,
      email,
      tenantId: authContext.tenantId,
      tenantSlug: authContext.tenantSlug,
      isSuperAdmin: authContext.isSuperAdmin,
    };

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

  private async generateTenantSelectionToken(
    userId: string,
    email: string,
  ): Promise<string> {
    const payload: TenantSelectionTokenPayload = {
      sub: userId,
      email,
      purpose: 'tenant-selection',
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      expiresIn: '5m',
    });
  }

  private async verifyTenantSelectionToken(
    tempToken: string,
  ): Promise<TenantSelectionTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<TenantSelectionTokenPayload>(
        tempToken,
        {
          secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        },
      );

      if (payload.purpose !== 'tenant-selection') {
        throw new UnauthorizedException('Invalid token purpose');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired temp token');
    }
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
