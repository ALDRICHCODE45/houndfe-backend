import {
  ForbiddenException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import type { IUserRepository } from './domain/user.repository';
import type { CaslAbilityFactory } from './authorization/casl-ability.factory';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { User } from './domain/user.entity';
import { LoginOtpService, otpRateLimited } from './login-otp.service';
import * as bcrypt from 'bcrypt';
import { InvalidCredentialsError } from '../shared/domain/domain-error';

describe('AuthService - login multi-tenant flow', () => {
  const loginDto: LoginDto = {
    email: 'john@example.com',
    password: 'password123',
  };

  const createMockUser = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      id: 'user-1',
      email: { value: 'john@example.com' },
      hashedPassword: {
        compare: jest.fn().mockResolvedValue(true),
      },
      isActive: true,
      toResponse: jest.fn().mockReturnValue({
        id: 'user-1',
        email: 'john@example.com',
        name: 'John',
        isActive: true,
      }),
      updateRefreshToken: jest.fn(),
      ...overrides,
    }) as unknown as User;

  const createService = () => {
    const userRepo = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      save: jest.fn(),
      existsByEmail: jest.fn(),
      findAll: jest.fn(),
      findByIdWithRoles: jest.fn(),
      update: jest.fn(),
    };

    const jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token'),
      verifyAsync: jest.fn(),
    };

    const configService = {
      get: jest
        .fn()
        .mockImplementation(
          (key: string, fallback?: string) => fallback ?? key,
        ),
      getOrThrow: jest.fn().mockImplementation((key: string) => key),
    } as unknown as ConfigService;

    const caslAbilityFactory = {
      getEffectivePermissions: jest.fn(),
    } as unknown as CaslAbilityFactory;

    const prisma = {
      tenantMembership: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      tenant: {
        findUnique: jest.fn(),
      },
      role: {
        findFirst: jest.fn(),
      },
    };

    const otp = {
      issue: jest.fn().mockResolvedValue({
        requiresOtp: true,
        challengeId: 'a'.repeat(43),
        expiresIn: 600,
        resendAfter: 60,
      }),
      verify: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', email: 'john@example.com' }),
      resend: jest.fn(),
    };

    const service = new AuthService(
      userRepo as unknown as IUserRepository,
      jwtService as unknown as JwtService,
      configService,
      caslAbilityFactory,
      prisma as unknown as PrismaService,
      otp as unknown as LoginOtpService,
    );

    return {
      service,
      userRepo,
      jwtService,
      prisma,
      otp,
    };
  };

  it('returns only an OTP challenge after correct password, never credentials', async () => {
    const { service, userRepo, prisma, jwtService, otp } = createService();
    const user = createMockUser();
    userRepo.findByEmail.mockResolvedValue(user);
    userRepo.findById.mockResolvedValue(user);
    prisma.tenantMembership.findMany.mockResolvedValue([]);
    prisma.role.findFirst.mockResolvedValue({
      id: 'superadmin',
    });
    const result = await service.login(loginDto);
    expect(result).toEqual({
      requiresOtp: true,
      challengeId: 'a'.repeat(43),
      expiresIn: 600,
      resendAfter: 60,
    });
    expect(otp.issue).toHaveBeenCalledWith('user-1');
    expect(prisma.tenantMembership.findMany).not.toHaveBeenCalled();
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(userRepo.save).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects legacy tenant-selection tokens without OTP proof', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'john@example.com',
      purpose: 'tenant-selection',
    });
    userRepo.findById.mockResolvedValue(createMockUser());
    prisma.tenantMembership.findFirst.mockResolvedValue({
      tenant: { id: 'tenant-1', slug: 'centro', isActive: true },
    });
    await expect(
      service.selectTenant({ tempToken: 'legacy', tenantId: 'tenant-1' }),
    ).rejects.toThrow('Invalid or expired temp token');
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'wrong password', 'disabled'])(
    'rejects %s before OTP issuance',
    async (kind) => {
      const { service, userRepo, jwtService, otp, prisma } = createService();
      const user = createMockUser({
        isActive: kind !== 'disabled',
        hashedPassword: {
          compare: jest.fn().mockResolvedValue(kind !== 'wrong password'),
        },
      });
      userRepo.findByEmail.mockResolvedValue(kind === 'unknown' ? null : user);
      await expect(service.login(loginDto)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      expect(otp.issue).not.toHaveBeenCalled();
      expect(otp.verify).not.toHaveBeenCalled();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(prisma.tenantMembership.findMany).not.toHaveBeenCalled();
      expect(userRepo.save).not.toHaveBeenCalled();
    },
  );

  it.each(['wrong', 'expired', 'replayed', 'exhausted'])(
    'never creates a session for %s OTP',
    async () => {
      const { service, userRepo, jwtService, otp } = createService();
      const error = new UnauthorizedException({
        statusCode: 401,
        code: 'OTP_INVALID',
      });
      otp.verify.mockRejectedValue(error);
      await expect(
        service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
      ).rejects.toBe(error);
      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(userRepo.findById).not.toHaveBeenCalled();
      expect(userRepo.save).not.toHaveBeenCalled();
    },
  );

  it.each([null, false, 'changed email'])(
    'rechecks identity after consumption: %s',
    async (state) => {
      const { service, userRepo, jwtService } = createService();
      userRepo.findById.mockResolvedValue(
        state === null
          ? null
          : createMockUser({
              isActive: state !== false,
              email: {
                value:
                  state === 'changed email'
                    ? 'changed@example.com'
                    : 'john@example.com',
              },
            }),
      );
      await expect(
        service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
      ).rejects.toThrow();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    },
  );

  it('waits for OTP consumption before looking up tenants or signing', async () => {
    const { service, userRepo, jwtService, otp, prisma } = createService();
    let consume!: (identity: { id: string; email: string }) => void;
    otp.verify.mockReturnValue(
      new Promise((resolve) => {
        consume = resolve;
      }),
    );
    userRepo.findById.mockResolvedValue(createMockUser());
    prisma.tenantMembership.findMany.mockResolvedValue([]);
    prisma.role.findFirst.mockResolvedValue({
      id: 'superadmin',
    });
    const pending = service.verifyLoginOtp({
      challengeId: 'a'.repeat(43),
      code: '000123',
    });
    expect(otp.verify).toHaveBeenCalledWith('a'.repeat(43), '000123');
    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(prisma.tenantMembership.findMany).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    consume({ id: 'user-1', email: 'john@example.com' });
    await expect(pending).resolves.toHaveProperty('accessToken');
  });

  it('registration returns only the created user without issuing OTP or credentials', async () => {
    const { service, userRepo, jwtService, otp } = createService();
    userRepo.existsByEmail.mockResolvedValue(false);
    const user = createMockUser();
    userRepo.save.mockResolvedValue(user);
    await expect(
      service.register({ ...loginDto, name: 'John' }),
    ).resolves.toEqual({ user: user.toResponse() });
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    expect(otp.issue).not.toHaveBeenCalled();
    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(userRepo.save).toHaveBeenCalledTimes(1);
  });

  it('resend returns the replacement envelope unchanged', async () => {
    const { service, otp, jwtService } = createService();
    const replacement = {
      requiresOtp: true,
      challengeId: 'b'.repeat(43),
      expiresIn: 600,
      resendAfter: 60,
    };
    otp.resend.mockResolvedValue(replacement);
    await expect(
      service.resendLoginOtp({ challengeId: 'a'.repeat(43) }),
    ).resolves.toBe(replacement);
    expect(otp.resend).toHaveBeenCalledWith('a'.repeat(43));
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it.each([otpRateLimited(42), new ServiceUnavailableException('unavailable')])(
    'preserves issuance/resend failures without signing',
    async (error) => {
      const { service, userRepo, otp, jwtService } = createService();
      userRepo.findByEmail.mockResolvedValue(createMockUser());
      otp.issue.mockRejectedValue(error);
      otp.resend.mockRejectedValue(error);
      await expect(service.login(loginDto)).rejects.toBe(error);
      await expect(
        service.resendLoginOtp({ challengeId: 'a'.repeat(43) }),
      ).rejects.toBe(error);
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    },
  );

  const verifiedSelection = {
    sub: 'user-1',
    email: 'john@example.com',
    purpose: 'tenant-selection',
    authProof: 'password-email-otp-v1',
  };

  it('accepts OTP-proven tenant selection with active membership and user', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    jwtService.verifyAsync.mockResolvedValue(verifiedSelection);
    userRepo.findById.mockResolvedValue(createMockUser());
    prisma.tenantMembership.findFirst.mockResolvedValue({
      tenant: { id: 'tenant-1', slug: 'centro', isActive: true },
    });
    await expect(
      service.selectTenant({ tempToken: 'verified', tenantId: 'tenant-1' }),
    ).resolves.toHaveProperty('accessToken', 'access-token');
    expect(prisma.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', tenantId: 'tenant-1' },
      include: { tenant: true },
    });
  });

  it.each([
    { purpose: 'other' },
    { authProof: 'legacy' },
    { sub: '' },
    { sub: 123 },
    { email: '' },
    { email: null },
  ])('rejects malformed pending claims %j', async (override) => {
    const { service, jwtService, prisma } = createService();
    jwtService.verifyAsync.mockResolvedValue({
      ...verifiedSelection,
      ...override,
    });
    await expect(
      service.selectTenant({ tempToken: 'bad', tenantId: 'tenant-1' }),
    ).rejects.toThrow('Invalid or expired temp token');
    expect(jwtService.signAsync).not.toHaveBeenCalled();
    expect(prisma.tenantMembership.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    'missing membership',
    'inactive tenant',
    'missing user',
    'inactive user',
    'changed email',
  ])('denies verified selection for %s', async (state) => {
    const { service, userRepo, prisma, jwtService } = createService();
    jwtService.verifyAsync.mockResolvedValue(verifiedSelection);
    userRepo.findById.mockResolvedValue(
      state === 'missing user'
        ? null
        : createMockUser({
            isActive: state !== 'inactive user',
            email: {
              value:
                state === 'changed email'
                  ? 'changed@example.com'
                  : 'john@example.com',
            },
          }),
    );
    prisma.tenantMembership.findFirst.mockResolvedValue(
      state === 'missing membership'
        ? null
        : {
            tenant: {
              id: 'tenant-1',
              slug: 'centro',
              isActive: state !== 'inactive tenant',
            },
          },
    );
    await expect(
      service.selectTenant({ tempToken: 'verified', tenantId: 'tenant-1' }),
    ).rejects.toThrow();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('refreshes grandfathered final sessions using the refresh secret without OTP proof', async () => {
    const { service, userRepo, jwtService, otp } = createService();
    const hashedRefreshToken = await bcrypt.hash('old-final-refresh', 4);
    userRepo.findById.mockResolvedValue(createMockUser({ hashedRefreshToken }));
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'john@example.com',
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      isSuperAdmin: false,
    });
    await expect(service.refreshTokens('old-final-refresh')).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('old-final-refresh', {
      secret: 'JWT_REFRESH_SECRET',
    });
    expect(otp.issue).not.toHaveBeenCalled();
  });

  it.each(['missing user', 'disabled', 'missing hash', 'wrong hash'])(
    'rejects invalid final refresh session: %s',
    async (state) => {
      const { service, userRepo, jwtService } = createService();
      const hash = await bcrypt.hash('stored-final-refresh', 4);
      userRepo.findById.mockResolvedValue(
        state === 'missing user'
          ? null
          : createMockUser({
              isActive: state !== 'disabled',
              hashedRefreshToken: state === 'missing hash' ? null : hash,
            }),
      );
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'john@example.com',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
      });
      await expect(
        service.refreshTokens('other-final-refresh'),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid refresh signatures before user lookup', async () => {
    const { service, userRepo, jwtService } = createService();
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await expect(service.refreshTokens('invalid')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it.each(['tenant-selection', '', false, null])(
    'rejects any defined purpose at refresh boundary: %s',
    async (purpose) => {
      const { service, userRepo, jwtService } = createService();
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        email: 'john@example.com',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
        purpose,
      });
      await expect(service.refreshTokens('temporary')).rejects.toThrow();
      expect(userRepo.findById).not.toHaveBeenCalled();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    },
  );

  it('returns full tokens when user has one active tenant membership', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    const user = createMockUser();

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    prisma.tenantMembership.findMany.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        tenant: {
          id: 'tenant-1',
          name: 'Centro',
          slug: 'centro',
          isActive: true,
        },
      },
    ]);
    prisma.role.findFirst.mockResolvedValue(null);

    await expect(
      service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
    ).resolves.toMatchObject({
      requiresTenantSelection: false,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tenants: [{ id: 'tenant-1', name: 'Centro', slug: 'centro' }],
      user: {
        id: 'user-1',
      },
    });

    expect(jwtService.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        email: 'john@example.com',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
      }),
      expect.any(Object),
    );
  });

  it('returns temp token when user has multiple active memberships', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    const user = createMockUser();
    jwtService.signAsync.mockReset();
    jwtService.signAsync.mockResolvedValueOnce('temp-token');

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    prisma.tenantMembership.findMany.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        tenant: {
          id: 'tenant-1',
          name: 'Centro',
          slug: 'centro',
          isActive: true,
        },
      },
      {
        tenantId: 'tenant-2',
        tenant: {
          id: 'tenant-2',
          name: 'Norte',
          slug: 'norte',
          isActive: true,
        },
      },
    ]);
    prisma.role.findFirst.mockResolvedValue(null);

    await expect(
      service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
    ).resolves.toMatchObject({
      requiresTenantSelection: true,
      tempToken: 'temp-token',
      expiresIn: 300,
      tenants: [
        { id: 'tenant-1', name: 'Centro', slug: 'centro' },
        { id: 'tenant-2', name: 'Norte', slug: 'norte' },
      ],
      user: { id: 'user-1' },
    });

    expect(jwtService.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        email: 'john@example.com',
        purpose: 'tenant-selection',
        authProof: 'password-email-otp-v1',
      }),
      expect.any(Object),
    );
  });

  it('returns super-admin global tokens with null tenant context', async () => {
    const { service, userRepo, prisma, jwtService, otp } = createService();
    otp.verify.mockResolvedValue({ id: 'user-1', email: 'root@example.com' });
    const user = createMockUser({ email: { value: 'root@example.com' } });

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    prisma.tenantMembership.findMany.mockResolvedValue([]);
    prisma.role.findFirst.mockResolvedValue({ id: 'role-sa' });

    await expect(
      service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
    ).resolves.toMatchObject({
      requiresTenantSelection: false,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { id: 'user-1' },
      tenants: [],
    });

    expect(jwtService.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        email: 'root@example.com',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
      }),
      expect.any(Object),
    );
  });

  it('throws ForbiddenException when user has no active tenant and is not super-admin', async () => {
    const { service, userRepo, prisma } = createService();
    const user = createMockUser();

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    prisma.tenantMembership.findMany.mockResolvedValue([]);
    prisma.role.findFirst.mockResolvedValue(null);

    await expect(
      service.verifyLoginOtp({ challengeId: 'a'.repeat(43), code: '000123' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService - switchTenant', () => {
  const createMockUser = () =>
    ({
      id: 'user-1',
      email: { value: 'john@example.com' },
      updateRefreshToken: jest.fn(),
      toResponse: jest.fn(),
    }) as unknown as User;

  const createService = () => {
    const userRepo = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      save: jest.fn(),
      existsByEmail: jest.fn(),
      findAll: jest.fn(),
      findByIdWithRoles: jest.fn(),
      update: jest.fn(),
    };

    const jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token'),
      verifyAsync: jest.fn(),
    };

    const configService = {
      get: jest
        .fn()
        .mockImplementation(
          (_key: string, fallback?: string) => fallback ?? _key,
        ),
      getOrThrow: jest.fn().mockImplementation((key: string) => key),
    } as unknown as ConfigService;

    const caslAbilityFactory = {
      getEffectivePermissions: jest.fn(),
    } as unknown as CaslAbilityFactory;

    const prisma = {
      tenantMembership: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      tenant: {
        findUnique: jest.fn(),
      },
      role: {
        findFirst: jest.fn(),
      },
    };

    const otp = {
      issue: jest.fn().mockResolvedValue({
        requiresOtp: true,
        challengeId: 'a'.repeat(43),
        expiresIn: 600,
        resendAfter: 60,
      }),
      verify: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', email: 'john@example.com' }),
      resend: jest.fn(),
    };

    const service = new AuthService(
      userRepo as unknown as IUserRepository,
      jwtService as unknown as JwtService,
      configService,
      caslAbilityFactory,
      prisma as unknown as PrismaService,
      otp as unknown as LoginOtpService,
    );

    return { service, userRepo, jwtService, prisma };
  };

  it('super-admin switches to a specific tenant', async () => {
    const { service, userRepo, prisma } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-b',
      slug: 'norte',
      isActive: true,
    });

    const result = await service.switchTenant(
      {
        userId: 'user-1',
        email: 'john@example.com',
        tenantId: 'tenant-a',
        tenantSlug: 'centro',
        isSuperAdmin: true,
      },
      { tenantId: 'tenant-b' },
    );

    expect(result).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
  });

  it('super-admin switches to global context (null tenant)', async () => {
    const { service, userRepo } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);

    const result = await service.switchTenant(
      {
        userId: 'user-1',
        email: 'john@example.com',
        tenantId: 'tenant-a',
        tenantSlug: 'centro',
        isSuperAdmin: true,
      },
      { tenantId: null },
    );

    expect(result).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
  });

  it('non-super-admin with active membership switches tenant successfully', async () => {
    const { service, userRepo, prisma } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    prisma.tenantMembership.findFirst.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-b',
      tenant: { id: 'tenant-b', slug: 'norte', isActive: true },
    });

    const result = await service.switchTenant(
      {
        userId: 'user-1',
        email: 'john@example.com',
        tenantId: 'tenant-a',
        tenantSlug: 'centro',
        isSuperAdmin: false,
      },
      { tenantId: 'tenant-b' },
    );

    expect(result).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    expect(prisma.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', tenantId: 'tenant-b' },
      include: { tenant: true },
    });
  });

  it('non-super-admin without membership is denied', async () => {
    const { service, prisma } = createService();
    prisma.tenantMembership.findFirst.mockResolvedValue(null);

    await expect(
      service.switchTenant(
        {
          userId: 'user-1',
          email: 'john@example.com',
          tenantId: 'tenant-a',
          tenantSlug: 'centro',
          isSuperAdmin: false,
        },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_ACCESS_DENIED');
  });

  it('non-super-admin cannot switch to inactive tenant', async () => {
    const { service, prisma } = createService();
    prisma.tenantMembership.findFirst.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-b',
      tenant: { id: 'tenant-b', slug: 'norte', isActive: false },
    });

    await expect(
      service.switchTenant(
        {
          userId: 'user-1',
          email: 'john@example.com',
          tenantId: 'tenant-a',
          tenantSlug: 'centro',
          isSuperAdmin: false,
        },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_INACTIVE');
  });

  it('non-super-admin cannot switch to null tenantId (global context)', async () => {
    const { service } = createService();

    await expect(
      service.switchTenant(
        {
          userId: 'user-1',
          email: 'john@example.com',
          tenantId: 'tenant-a',
          tenantSlug: 'centro',
          isSuperAdmin: false,
        },
        { tenantId: null },
      ),
    ).rejects.toThrow('SUPER_ADMIN_REQUIRED');
  });

  it('super-admin is denied when target tenant does not exist', async () => {
    const { service, prisma } = createService();
    prisma.tenant.findUnique.mockResolvedValue(null);

    await expect(
      service.switchTenant(
        {
          userId: 'user-1',
          email: 'john@example.com',
          tenantId: null,
          tenantSlug: null,
          isSuperAdmin: true,
        },
        { tenantId: 'nonexistent' },
      ),
    ).rejects.toThrow('TENANT_NOT_FOUND');
  });

  it('super-admin is denied when target tenant is inactive', async () => {
    const { service, prisma } = createService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-b',
      slug: 'norte',
      isActive: false,
    });

    await expect(
      service.switchTenant(
        {
          userId: 'user-1',
          email: 'john@example.com',
          tenantId: null,
          tenantSlug: null,
          isSuperAdmin: true,
        },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_INACTIVE');
  });
});
