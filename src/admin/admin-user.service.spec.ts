import { AdminUserService } from './admin-user.service';
import { Prisma } from '@prisma/client';
import { PrismaLoginOtpRepository } from '../auth/infrastructure/prisma-login-otp.repository';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../auth/authorization/domain/permission';
import type { UpdateUserDto } from './dto/update-user.dto';

function userFixture(id: string, email: string, name: string) {
  return {
    id,
    email,
    hashedPassword: 'hash',
    name,
    isActive: true,
    hashedRefreshToken: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };
}

function tenantMembershipFixture(
  user: ReturnType<typeof userFixture>,
  role: { id: string; name: string },
) {
  return { user, role };
}

function createService(opts: {
  clsValue: { tenantId: string | null; isSuperAdmin: boolean };
  prismaClient?: Record<string, any>;
  tenantPrismaClient?: Record<string, any>;
}) {
  const defaultTenantMembership = {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  };

  return new AdminUserService(
    {} as any,
    {} as any,
    (opts.prismaClient ?? { user: { findUnique: jest.fn() } }) as any,
    {
      getClient: jest.fn().mockReturnValue(
        opts.tenantPrismaClient ?? {
          tenantMembership: defaultTenantMembership,
        },
      ),
    } as any,
    { get: jest.fn().mockReturnValue(opts.clsValue) } as any,
  );
}

describe('AdminUserService', () => {
  it('findOne should throw when user has no membership in current tenant', async () => {
    const tenantPrismaClient = {
      tenantMembership: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = new AdminUserService(
      {
        findByIdWithRoles: jest.fn().mockResolvedValue({
          user: { toResponse: () => ({ id: 'u1' }) },
          roles: [{ id: 'r-cross-tenant', name: 'Cross Tenant Role' }],
        }),
      } as any,
      {} as any,
      { user: { findUnique: jest.fn() } } as any,
      { getClient: jest.fn().mockReturnValue(tenantPrismaClient) } as any,
      {
        get: jest
          .fn()
          .mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }),
      } as any,
    );

    await expect(service.findOne('u1')).rejects.toThrow(
      'User with id "u1" not found',
    );
  });

  it('findOne should return only roles from current tenant memberships', async () => {
    const tenantPrismaClient = {
      tenantMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tm-1' }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { role: { id: 'r-tenant', name: 'Tenant Role' } },
          ]),
        count: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = new AdminUserService(
      {
        findByIdWithRoles: jest.fn().mockResolvedValue({
          user: { toResponse: () => ({ id: 'u1' }) },
          roles: [
            { id: 'r-cross-tenant', name: 'Cross Tenant Role' },
            { id: 'r-tenant', name: 'Tenant Role' },
          ],
        }),
      } as any,
      {} as any,
      { user: { findUnique: jest.fn() } } as any,
      { getClient: jest.fn().mockReturnValue(tenantPrismaClient) } as any,
      {
        get: jest
          .fn()
          .mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }),
      } as any,
    );

    const result = await service.findOne('u1');

    expect(result.roles).toEqual([{ id: 'r-tenant', name: 'Tenant Role' }]);
    expect(tenantPrismaClient.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', tenantId: 'tenant-1' },
      }),
    );
  });

  it('findAll should list only users from current tenant memberships', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([
        tenantMembershipFixture(userFixture('u1', 'u1@test.com', 'User 1'), {
          id: 'r1',
          name: 'Role 1',
        }),
      ]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(),
      create: jest.fn(),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].roles).toEqual([{ id: 'r1', name: 'Role 1' }]);
    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    );
  });

  it('findAll should filter by name with case-insensitive contains', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([
        tenantMembershipFixture(userFixture('u1', 'alice@test.com', 'Alice'), {
          id: 'r1',
          name: 'Admin',
        }),
      ]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({
      page: 1,
      limit: 20,
      search: 'ALICE',
    });

    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          OR: [
            { user: { name: { contains: 'ALICE', mode: 'insensitive' } } },
            { user: { email: { contains: 'ALICE', mode: 'insensitive' } } },
            { role: { name: { contains: 'ALICE', mode: 'insensitive' } } },
          ],
        },
      }),
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe('Alice');
    expect(result.meta.total).toBe(1);
  });

  it('findAll should filter by email', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([
        tenantMembershipFixture(userFixture('u2', 'bob@example.com', 'Bob'), {
          id: 'r1',
          name: 'Admin',
        }),
      ]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({
      page: 1,
      limit: 20,
      search: 'bob@example.com',
    });

    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              user: {
                email: { contains: 'bob@example.com', mode: 'insensitive' },
              },
            },
          ]),
        }),
      }),
    );
    expect(result.data).toHaveLength(1);
    expect(result.data[0].email).toBe('bob@example.com');
  });

  it('findAll should match users by role name in the tenant branch', async () => {
    const tenantMembershipClient = {
      findMany: jest
        .fn()
        .mockResolvedValue([
          tenantMembershipFixture(
            userFixture('u1', 'alice@test.com', 'Alice'),
            { id: 'r-cashier', name: 'Cashier' },
          ),
        ]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({
      page: 1,
      limit: 20,
      search: 'CASHIER',
    });

    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              role: { name: { contains: 'CASHIER', mode: 'insensitive' } },
            },
          ]),
        }),
      }),
    );
    expect(result.data[0].roles).toEqual([
      { id: 'r-cashier', name: 'Cashier' },
    ]);
  });

  it('findAll should reject single-character searches', async () => {
    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
    });

    await expect(service.findAll({ search: 'a' })).rejects.toThrow(
      'SEARCH_QUERY_TOO_SHORT',
    );
  });

  it('findAll should sort by user name descending', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    await service.findAll({ sortBy: 'name', sortOrder: 'desc' });

    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { user: { name: 'desc' } } }),
    );
  });

  it('findAll should sort by createdAt ascending', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    await service.findAll({ sortBy: 'createdAt', sortOrder: 'asc' });

    expect(tenantMembershipClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { user: { createdAt: 'asc' } } }),
    );
  });

  it('findAll should merge multiple memberships of the same user into one row', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([
        tenantMembershipFixture(userFixture('u1', 'u1@test.com', 'User 1'), {
          id: 'r1',
          name: 'Admin',
        }),
        tenantMembershipFixture(userFixture('u1', 'u1@test.com', 'User 1'), {
          id: 'r2',
          name: 'Cashier',
        }),
      ]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].roles).toEqual([
      { id: 'r1', name: 'Admin' },
      { id: 'r2', name: 'Cashier' },
    ]);
    expect(result.meta.total).toBe(1);
  });

  it('findAll should paginate merged users and count distinct users in total', async () => {
    const tenantMembershipClient = {
      findMany: jest.fn().mockResolvedValue([
        tenantMembershipFixture(userFixture('u1', 'u1@test.com', 'User 1'), {
          id: 'r1',
          name: 'Admin',
        }),
        tenantMembershipFixture(userFixture('u1', 'u1@test.com', 'User 1'), {
          id: 'r2',
          name: 'Cashier',
        }),
        tenantMembershipFixture(userFixture('u2', 'u2@test.com', 'User 2'), {
          id: 'r1',
          name: 'Admin',
        }),
      ]),
    } as any;

    const service = createService({
      clsValue: { tenantId: 'tenant-1', isSuperAdmin: false },
      tenantPrismaClient: { tenantMembership: tenantMembershipClient },
    });

    const result = await service.findAll({ page: 1, limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe('User 1');
    expect(result.meta.total).toBe(2);
    expect(result.meta.totalPages).toBe(2);
  });

  it('findAll as superadmin should aggregate roles across tenants', async () => {
    const prismaClient = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...userFixture('u1', 'u1@test.com', 'User 1'),
            tenantMemberships: [
              { role: { id: 'r1', name: 'Admin' } },
              { role: { id: 'r2', name: 'Cashier' } },
              { role: { id: 'r2', name: 'Cashier' } },
            ],
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as any;

    const service = createService({
      clsValue: { tenantId: null, isSuperAdmin: true },
      prismaClient,
    });

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].roles).toEqual([
      { id: 'r1', name: 'Admin' },
      { id: 'r2', name: 'Cashier' },
    ]);
    expect(result.meta.total).toBe(1);
    expect(prismaClient.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          tenantMemberships: {
            select: { role: { select: { id: true, name: true } } },
          },
        },
      }),
    );
  });

  it('findAll as superadmin should search by role name and sort on user fields', async () => {
    const prismaClient = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;

    const service = createService({
      clsValue: { tenantId: null, isSuperAdmin: true },
      prismaClient,
    });

    await service.findAll({
      search: 'cashier',
      sortBy: 'name',
      sortOrder: 'asc',
    });

    expect(prismaClient.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: 'cashier', mode: 'insensitive' } },
            { email: { contains: 'cashier', mode: 'insensitive' } },
            {
              tenantMemberships: {
                some: {
                  role: { name: { contains: 'cashier', mode: 'insensitive' } },
                },
              },
            },
          ],
        },
        orderBy: { name: 'asc' },
      }),
    );
  });

  it('create should create tenant membership for current tenant', async () => {
    const tenantPrismaClient = {
      tenantMembership: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tm-1' }),
      },
    } as any;

    const service = new AdminUserService(
      {
        save: jest.fn(),
        findById: jest
          .fn()
          .mockResolvedValue({ toResponse: () => ({ id: 'u1' }) }),
      } as any,
      { findById: jest.fn().mockResolvedValue({ id: 'r1' }) } as any,
      {
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      } as any,
      { getClient: jest.fn().mockReturnValue(tenantPrismaClient) } as any,
      {
        get: jest
          .fn()
          .mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }),
      } as any,
    );

    await service.create({
      email: 'u1@test.com',
      password: 'password123',
      name: 'User 1',
      roleId: 'r1',
    });

    expect(tenantPrismaClient.tenantMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', roleId: 'r1' }),
      }),
    );
  });
});

describe('AdminUserService atomic profile and role editing', () => {
  const tenantId = 'tenant-1';
  const roleA = '11111111-1111-4111-8111-111111111111';
  const roleB = '22222222-2222-4222-8222-222222222222';
  type Scope = { userId: string; tenantId: string };
  type Membership = Scope & {
    id: string;
    roleId: string;
    role: { tenantId: string | null };
  };

  function setup() {
    const actor: AuthenticatedUser = {
      userId: 'u1',
      email: 'old@example.com',
      tenantId,
      tenantSlug: 'tenant-1',
      isSuperAdmin: false,
    };
    let state = {
      user: {
        ...userFixture('u1', 'old@example.com', 'Old'),
        hashedRefreshToken: 'refresh',
        isActive: false,
      },
      memberships: [
        {
          id: 'keep',
          userId: 'u1',
          tenantId,
          roleId: roleA,
          role: { tenantId },
        },
        {
          id: 'other',
          userId: 'u1',
          tenantId: 'other',
          roleId: roleB,
          role: { tenantId: 'other' },
        },
      ] as Membership[],
      challenge: {
        state: 'PENDING',
        generation: 'generation',
        attempts: 2,
        expiresAt: new Date(Date.now() + 600_000),
      },
      bucket: { count: 2 },
    };
    const ability = {
      can: jest.fn<boolean, [string, string]>().mockReturnValue(true),
    };
    const tx = {
      $queryRaw: jest
        .fn<Promise<{ id: string }[]>, [Prisma.Sql]>()
        .mockResolvedValue([{ id: 'u1' }]),
      user: {
        findUnique: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { id?: string; email?: string } }) =>
              where.id ? state.user : null,
          ),
        update: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: { name: string; email?: string } }) => {
              state.user = { ...state.user, ...data };
              return state.user;
            },
          ),
      },
      role: {
        findFirst: jest
          .fn<Promise<{ id: string } | null>, [unknown]>()
          .mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { id: { in: string[] } } }) =>
              where.id.in.map((id) => ({ id, tenantId })),
          ),
      },
      tenantMembership: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: Scope }) =>
            state.memberships.filter(
              (m) => m.userId === where.userId && m.tenantId === where.tenantId,
            ),
          ),
        deleteMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: Scope & { roleId: { notIn: string[] } } }) => {
              state.memberships = state.memberships.filter(
                (m) =>
                  !(
                    m.userId === where.userId &&
                    m.tenantId === where.tenantId &&
                    !where.roleId.notIn.includes(m.roleId)
                  ),
              );
              return { count: 1 };
            },
          ),
        createMany: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: Array<Scope & { roleId: string }> }) => {
              state.memberships.push(
                ...data.map((m) => ({
                  ...m,
                  id: 'new',
                  role: { tenantId: m.tenantId },
                })),
              );
              return { count: data.length };
            },
          ),
      },
      loginOtpChallenge: {
        findUnique: jest.fn().mockImplementation(() => state.challenge),
        update: jest.fn(),
        updateMany: jest
          .fn()
          .mockImplementation(
            ({
              where,
              data,
            }: {
              where: { userId: string; state: { in: string[] } };
              data: { state: string };
            }) => {
              if (
                where.userId === state.user.id &&
                where.state.in.includes(state.challenge.state)
              ) {
                Object.assign(state.challenge, data);
              }
              return { count: 1 };
            },
          ),
      },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation(
          async (callback: (client: typeof tx) => Promise<unknown>) => {
            const before = structuredClone(state);
            try {
              return await callback(tx);
            } catch (error) {
              state = before;
              throw error;
            }
          },
        ),
    };
    const repo = { update: jest.fn() };
    type Dependencies = ConstructorParameters<typeof AdminUserService>;
    const service = new AdminUserService(
      repo as unknown as Dependencies[0],
      {} as Dependencies[1],
      prisma as unknown as PrismaService,
      {} as Dependencies[3],
      { get: () => actor } as unknown as Dependencies[4],
    );
    const update = (dto: UpdateUserDto = { name: 'New' }) =>
      service.update('u1', dto, actor, ability as unknown as AppAbility);
    return { actor, ability, tx, prisma, repo, update, state: () => state };
  }

  it('locks first and writes only selected fields without leaking credentials', async () => {
    const s = setup();
    const before = structuredClone(s.state());
    const result = await s.update({
      name: ' New ',
      email: ' NEW@EXAMPLE.COM ',
      roleIds: [roleA, roleB],
    });
    expect(result).toEqual({
      id: 'u1',
      name: 'New',
      email: 'new@example.com',
      isActive: false,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('hashedPassword');
    expect(result).not.toHaveProperty('hashedRefreshToken');
    expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = s.tx.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join('?')).toBe(
      'SELECT "id" FROM "users" WHERE "id" = ? FOR UPDATE',
    );
    expect(sql.values).toEqual(['u1']);
    const lockOrder = s.tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(
      s.tx.user.findUnique.mock.invocationCallOrder[0],
    );
    expect(lockOrder).toBeLessThan(
      s.tx.tenantMembership.findMany.mock.invocationCallOrder[0],
    );
    expect(lockOrder).toBeLessThan(
      s.tx.role.findMany.mock.invocationCallOrder[0],
    );
    expect(s.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { name: 'New', email: 'new@example.com' },
    });
    expect(s.repo.update).not.toHaveBeenCalled();
    expect(s.state().user).toMatchObject({
      hashedPassword: 'hash',
      hashedRefreshToken: 'refresh',
      isActive: false,
    });
    expect(s.state().memberships).toContainEqual(before.memberships[0]);
    expect(s.state().memberships).toContainEqual(before.memberships[1]);
    expect(
      s
        .state()
        .memberships.filter((m) => m.tenantId === tenantId)
        .map((m) => m.roleId),
    ).toEqual([roleA, roleB]);
    expect(s.state().challenge).toEqual({
      ...before.challenge,
      state: 'FAILED',
    });
    expect(s.state().bucket).toEqual(before.bucket);
    expect(s.tx.role.findMany).toHaveBeenCalledWith({
      where: { id: { in: [roleA, roleB] }, tenantId },
      select: { id: true, tenantId: true },
    });
  });

  it.each(['PENDING', 'ACTIVE'])(
    'invalidates %s OTP and cannot revive it by reverting email',
    async (state) => {
      const s = setup();
      s.state().challenge.state = state;
      await s.update({ name: 'New', email: 'new@example.com' });
      await s.update({ name: 'New', email: 'old@example.com' });
      expect(s.state().challenge.state).toBe('FAILED');
      expect(s.tx.loginOtpChallenge.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', state: { in: ['PENDING', 'ACTIVE'] } },
        data: { state: 'FAILED' },
      });
    },
  );

  it('rejects delayed successful delivery through the real OTP repository completion', async () => {
    const s = setup();
    s.state().user.isActive = true;
    const otp = new PrismaLoginOtpRepository(
      s.prisma as unknown as PrismaService,
    );
    let deliver: (accepted: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      deliver = resolve;
    });
    const completion = pending.then((accepted) =>
      otp.complete('u1', 'generation', accepted),
    );
    await s.update({ name: 'New', email: 'new@example.com' });
    await s.update({ name: 'New', email: 'old@example.com' });
    deliver(true);
    await expect(completion).resolves.toBe(false);
    expect(s.tx.loginOtpChallenge.update).not.toHaveBeenCalled();
    expect(s.state().challenge.state).toBe('FAILED');
  });

  it.each([undefined, ' OLD@EXAMPLE.COM '])(
    'leaves OTP and roles unchanged for unchanged/omitted email %p',
    async (email) => {
      const s = setup();
      const before = structuredClone(s.state());
      await s.update({
        name: 'New',
        ...(email === undefined ? {} : { email }),
      });
      expect(s.tx.loginOtpChallenge.updateMany).not.toHaveBeenCalled();
      expect(s.state().memberships).toEqual(before.memberships);
      expect(s.tx.tenantMembership.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each(['FAILED', 'CONSUMED'])(
    'preserves historical %s challenge fields',
    async (state) => {
      const s = setup();
      s.state().challenge.state = state;
      const before = structuredClone(s.state().challenge);
      await s.update({ name: 'New', email: 'new@example.com' });
      expect(s.state().challenge).toEqual(before);
    },
  );

  it.each(['User', 'TenantMembership'])(
    'requires update:%s before any profile write',
    async (denied) => {
      const s = setup();
      const before = structuredClone(s.state());
      s.ability.can.mockImplementation(
        (_action, subject) => subject !== denied,
      );
      await expect(
        s.update({ name: 'New', roleIds: [roleB] }),
      ).rejects.toMatchObject({ status: 403 });
      expect(s.state()).toEqual(before);
      expect(s.tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('permits name-only editing without membership mutation permission', async () => {
    const s = setup();
    s.ability.can.mockImplementation((_action, subject) => subject === 'User');
    await expect(s.update()).resolves.toMatchObject({ name: 'New' });
  });

  it.each([false, true])(
    'rejects cross-tenant targets with selected tenant (superadmin %p)',
    async (isSuperAdmin) => {
      const s = setup();
      s.actor.isSuperAdmin = isSuperAdmin;
      s.state().memberships = s
        .state()
        .memberships.filter((m) => m.tenantId !== tenantId);
      await expect(s.update()).rejects.toThrow('User with id "u1" not found');
      expect(s.tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('rejects missing users after locking, without writes', async () => {
    const s = setup();
    s.tx.user.findUnique.mockReturnValue(null);
    await expect(s.update()).rejects.toThrow('User with id "u1" not found');
    expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(s.tx.user.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'never permits role edits without tenant (superadmin %p)',
    async (isSuperAdmin) => {
      const s = setup();
      s.actor.tenantId = null;
      s.actor.isSuperAdmin = isSuperAdmin;
      await expect(
        s.update({ name: 'New', roleIds: [roleB] }),
      ).rejects.toMatchObject({ status: 403 });
      expect(s.tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('keeps global profile editing for global superadmin only', async () => {
    const s = setup();
    s.actor.tenantId = null;
    await expect(s.update()).rejects.toMatchObject({ status: 403 });
    s.actor.isSuperAdmin = true;
    await expect(s.update()).resolves.toMatchObject({ name: 'New' });
    expect(s.tx.tenantMembership.findMany).not.toHaveBeenCalled();
  });

  it('protects globally privileged targets using the exact login predicate', async () => {
    const s = setup();
    s.tx.role.findFirst.mockResolvedValue({ id: 'global' });
    await expect(s.update()).rejects.toMatchObject({ status: 403 });
    expect(s.tx.role.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: null,
        tenantMemberships: { some: { userId: 'u1' } },
        OR: [
          { isSystem: true, name: 'Super Admin' },
          {
            permissions: {
              some: { permission: { subject: 'all', action: 'manage' } },
            },
          },
        ],
      },
      select: { id: true },
    });
    expect(s.tx.user.update).not.toHaveBeenCalled();
    s.actor.isSuperAdmin = true;
    await expect(s.update()).resolves.toMatchObject({ name: 'New' });
  });

  it.each([null, 'other'])(
    'rejects foreign/global requested or existing roles: %p',
    async (roleTenant) => {
      const s = setup();
      const before = structuredClone(s.state());
      s.tx.role.findMany.mockReturnValue([{ id: roleB, tenantId: roleTenant }]);
      await expect(
        s.update({ name: 'New', roleIds: [roleB] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(s.state()).toEqual(before);
      s.tx.role.findMany.mockReturnValue([{ id: roleB, tenantId }]);
      s.state().memberships[0].role.tenantId = roleTenant;
      await expect(
        s.update({ name: 'New', roleIds: [roleB] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(s.tx.user.update).not.toHaveBeenCalled();
      await expect(s.update()).resolves.toMatchObject({ name: 'New' });
    },
  );

  it('rejects unknown requested roles without writes', async () => {
    const s = setup();
    s.tx.role.findMany.mockReturnValue([]);
    await expect(
      s.update({ name: 'New', roleIds: [roleB] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.tx.user.update).not.toHaveBeenCalled();
  });

  it.each([{ roleIds: [] }, { roleIds: [roleA, roleA] }])(
    'defensively rejects invalid role sets %p',
    async ({ roleIds }) => {
      const s = setup();
      await expect(s.update({ name: 'New', roleIds })).rejects.toMatchObject({
        status: 400,
      });
      expect(s.tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('uses the pre-change ability for self-demotion and only reconciles local rows', async () => {
    const s = setup();
    await s.update({ name: 'New', roleIds: [roleB] });
    expect(s.state().memberships.map((m) => m.id)).toEqual(['other', 'new']);
    expect(s.tx.tenantMembership.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', tenantId, roleId: { notIn: [roleB] } },
    });
  });

  it('keeps matching membership IDs when the supplied set is unchanged', async () => {
    const s = setup();
    const before = structuredClone(s.state().memberships);
    await s.update({ name: 'New', roleIds: [roleA] });
    expect(s.state().memberships).toEqual(before);
    expect(s.tx.tenantMembership.createMany).not.toHaveBeenCalled();
  });

  it('rejects normalized global duplicate email without writes', async () => {
    const s = setup();
    s.tx.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string } }) =>
        where.id ? s.state().user : { ...s.state().user, id: 'other' },
    );
    await expect(
      s.update({ name: 'New', email: ' TAKEN@EXAMPLE.COM ', roleIds: [roleB] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.tx.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'taken@example.com' },
    });
    expect(s.tx.user.update).not.toHaveBeenCalled();
  });

  it('translates a racing email P2002 without changing state', async () => {
    const s = setup();
    const before = structuredClone(s.state());
    s.tx.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      s.update({ name: 'New', email: 'new@example.com', roleIds: [roleB] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.state()).toEqual(before);
  });

  it.each(['P2002', 'persistence'])(
    'rolls back every simulated write on %s failure',
    async (kind) => {
      const s = setup();
      const before = structuredClone(s.state());
      const error =
        kind === 'P2002'
          ? new Prisma.PrismaClientKnownRequestError('unique', {
              code: 'P2002',
              clientVersion: 'test',
            })
          : new Error('persistence');
      s.tx.tenantMembership.createMany.mockRejectedValue(error);
      const result = s.update({
        name: 'New',
        email: 'new@example.com',
        roleIds: [roleB],
      });
      if (kind === 'P2002')
        await expect(result).rejects.toMatchObject({ status: 409 });
      else await expect(result).rejects.toThrow('persistence');
      expect(s.tx.user.update).toHaveBeenCalledTimes(1);
      expect(s.tx.loginOtpChallenge.updateMany).toHaveBeenCalledTimes(1);
      expect(s.tx.tenantMembership.deleteMany).toHaveBeenCalledTimes(1);
      expect(s.state()).toEqual(before);
    },
  );
});
