import { AdminRoleService } from './admin-role.service';

describe('AdminRoleService', () => {
  it('findOne should use tenant-scoped prisma client for role detail', async () => {
    const prisma = {
      role: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: 'role-1',
          name: 'Manager',
          description: null,
          isSystem: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          permissions: [],
        }),
        create: jest.fn(),
      },
    } as any;

    const service = new AdminRoleService(
      { findById: jest.fn() } as any,
      {} as any,
      { getClient: jest.fn().mockReturnValue(prisma) } as any,
      { get: jest.fn().mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }) } as any,
    );

    await service.findOne('role-1');

    expect(prisma.role.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'role-1' } }),
    );
  });

  it('findAll should filter roles by current tenant', async () => {
    const prisma = {
      role: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    const service = new AdminRoleService(
      {} as any,
      {} as any,
      { getClient: jest.fn().mockReturnValue(prisma) } as any,
      { get: jest.fn().mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }) } as any,
    );

    await service.findAll();

    expect(prisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    );
  });

  it('create should assign tenantId from CLS context', async () => {
    const prisma = {
      role: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'role-1',
          name: 'Manager',
          description: null,
          isSystem: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          permissions: [],
        }),
      },
    } as any;

    const service = new AdminRoleService(
      {} as any,
      {} as any,
      { getClient: jest.fn().mockReturnValue(prisma) } as any,
      { get: jest.fn().mockReturnValue({ tenantId: 'tenant-1', isSuperAdmin: false }) } as any,
    );

    await service.create({ name: 'Manager' });

    expect(prisma.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
  });
});
