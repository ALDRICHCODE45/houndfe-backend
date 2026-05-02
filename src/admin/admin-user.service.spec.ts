import { AdminUserService } from './admin-user.service';

describe('AdminUserService', () => {
  it('findAll should list only users from current tenant memberships', async () => {
    const tenantPrismaClient = {
      tenantMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            user: {
              id: 'u1',
              email: 'u1@test.com',
              hashedPassword: 'hash',
              name: 'User 1',
              isActive: true,
              hashedRefreshToken: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = new AdminUserService(
      {} as any,
      {} as any,
      { user: { findUnique: jest.fn() } } as any,
      { getClient: jest.fn().mockReturnValue(tenantPrismaClient) } as any,
      { get: jest.fn().mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }) } as any,
    );

    const result = await service.findAll(1, 20);

    expect(result.data).toHaveLength(1);
    expect(tenantPrismaClient.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
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
        findById: jest.fn().mockResolvedValue({ toResponse: () => ({ id: 'u1' }) }),
      } as any,
      { findById: jest.fn().mockResolvedValue({ id: 'r1' }) } as any,
      {
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      } as any,
      { getClient: jest.fn().mockReturnValue(tenantPrismaClient) } as any,
      { get: jest.fn().mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }) } as any,
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
