import { AdminUserService } from './admin-user.service';

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
