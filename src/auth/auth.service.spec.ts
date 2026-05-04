import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import type { IUserRepository } from './domain/user.repository';
import type { CaslAbilityFactory } from './authorization/casl-ability.factory';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';

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
    }) as any;

  const createService = () => {
    const userRepo = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      save: jest.fn(),
      existsByEmail: jest.fn(),
      findAll: jest.fn(),
      findByIdWithRoles: jest.fn(),
      assignRoles: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<IUserRepository>;

    const jwtService = {
      signAsync: jest.fn().mockResolvedValueOnce('access-token').mockResolvedValueOnce('refresh-token'),
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    const configService = {
      get: jest
        .fn()
        .mockImplementation((key: string, fallback?: string) => fallback ?? key),
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
    } as unknown as PrismaService;

    const service = new AuthService(
      userRepo,
      jwtService,
      configService,
      caslAbilityFactory,
      prisma,
    );

    return {
      service,
      userRepo,
      jwtService,
      prisma,
    };
  };

  it('returns full tokens when user has one active tenant membership', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    const user = createMockUser();

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    (prisma.tenantMembership.findMany as jest.Mock).mockResolvedValue([
      {
        tenantId: 'tenant-1',
        tenant: { id: 'tenant-1', name: 'Centro', slug: 'centro', isActive: true },
      },
    ]);
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.login(loginDto)).resolves.toMatchObject({
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
    (jwtService.signAsync as jest.Mock).mockReset();
    (jwtService.signAsync as jest.Mock).mockResolvedValueOnce('temp-token');

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    (prisma.tenantMembership.findMany as jest.Mock).mockResolvedValue([
      {
        tenantId: 'tenant-1',
        tenant: { id: 'tenant-1', name: 'Centro', slug: 'centro', isActive: true },
      },
      {
        tenantId: 'tenant-2',
        tenant: { id: 'tenant-2', name: 'Norte', slug: 'norte', isActive: true },
      },
    ]);
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.login(loginDto)).resolves.toMatchObject({
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
      }),
      expect.any(Object),
    );
  });

  it('returns super-admin global tokens with null tenant context', async () => {
    const { service, userRepo, prisma, jwtService } = createService();
    const user = createMockUser({ email: { value: 'root@example.com' } });

    userRepo.findByEmail = jest.fn().mockResolvedValue(user);
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    (prisma.tenantMembership.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.role.findFirst as jest.Mock).mockResolvedValue({ id: 'role-sa' });

    await expect(service.login(loginDto)).resolves.toMatchObject({
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
    (prisma.tenantMembership.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.role.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.login(loginDto)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService - switchTenant', () => {
  const createMockUser = () =>
    ({
      id: 'user-1',
      email: { value: 'john@example.com' },
      updateRefreshToken: jest.fn(),
      toResponse: jest.fn(),
    }) as any;

  const createService = () => {
    const userRepo = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      save: jest.fn(),
      existsByEmail: jest.fn(),
      findAll: jest.fn(),
      findByIdWithRoles: jest.fn(),
      assignRoles: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<IUserRepository>;

    const jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token'),
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    const configService = {
      get: jest.fn().mockImplementation((_key: string, fallback?: string) => fallback ?? _key),
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
    } as unknown as PrismaService;

    const service = new AuthService(
      userRepo,
      jwtService,
      configService,
      caslAbilityFactory,
      prisma,
    );

    return { service, userRepo, jwtService, prisma };
  };

  it('super-admin switches to a specific tenant', async () => {
    const { service, userRepo, prisma } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({
      id: 'tenant-b',
      slug: 'norte',
      isActive: true,
    });

    const result = await service.switchTenant(
      { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: true },
      { tenantId: 'tenant-b' },
    );

    expect(result).toEqual({ accessToken: 'new-access-token', refreshToken: 'new-refresh-token' });
  });

  it('super-admin switches to global context (null tenant)', async () => {
    const { service, userRepo } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);

    const result = await service.switchTenant(
      { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: true },
      { tenantId: null },
    );

    expect(result).toEqual({ accessToken: 'new-access-token', refreshToken: 'new-refresh-token' });
  });

  it('non-super-admin with active membership switches tenant successfully', async () => {
    const { service, userRepo, prisma } = createService();
    const user = createMockUser();
    userRepo.findById = jest.fn().mockResolvedValue(user);
    userRepo.save = jest.fn().mockResolvedValue(user);
    (prisma.tenantMembership.findFirst as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-b',
      tenant: { id: 'tenant-b', slug: 'norte', isActive: true },
    });

    const result = await service.switchTenant(
      { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: false },
      { tenantId: 'tenant-b' },
    );

    expect(result).toEqual({ accessToken: 'new-access-token', refreshToken: 'new-refresh-token' });
    expect(prisma.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', tenantId: 'tenant-b' },
      include: { tenant: true },
    });
  });

  it('non-super-admin without membership is denied', async () => {
    const { service, prisma } = createService();
    (prisma.tenantMembership.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.switchTenant(
        { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: false },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_ACCESS_DENIED');
  });

  it('non-super-admin cannot switch to inactive tenant', async () => {
    const { service, prisma } = createService();
    (prisma.tenantMembership.findFirst as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-b',
      tenant: { id: 'tenant-b', slug: 'norte', isActive: false },
    });

    await expect(
      service.switchTenant(
        { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: false },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_INACTIVE');
  });

  it('non-super-admin cannot switch to null tenantId (global context)', async () => {
    const { service } = createService();

    await expect(
      service.switchTenant(
        { userId: 'user-1', email: 'john@example.com', tenantId: 'tenant-a', tenantSlug: 'centro', isSuperAdmin: false },
        { tenantId: null },
      ),
    ).rejects.toThrow('SUPER_ADMIN_REQUIRED');
  });

  it('super-admin is denied when target tenant does not exist', async () => {
    const { service, prisma } = createService();
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.switchTenant(
        { userId: 'user-1', email: 'john@example.com', tenantId: null, tenantSlug: null, isSuperAdmin: true },
        { tenantId: 'nonexistent' },
      ),
    ).rejects.toThrow('TENANT_NOT_FOUND');
  });

  it('super-admin is denied when target tenant is inactive', async () => {
    const { service, prisma } = createService();
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({
      id: 'tenant-b',
      slug: 'norte',
      isActive: false,
    });

    await expect(
      service.switchTenant(
        { userId: 'user-1', email: 'john@example.com', tenantId: null, tenantSlug: null, isSuperAdmin: true },
        { tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow('TENANT_INACTIVE');
  });
});
