import { UsersService } from './users.service';

/** Build a membership row shaped like the Prisma select in findAssignableDrivers. */
function membership(permissions: Array<{ subject: string; action: string }>) {
  return {
    role: {
      permissions: permissions.map((permission) => ({ permission })),
    },
  };
}

describe('UsersService', () => {
  it('queries assignable active users scoped by tenant membership', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Ana Pérez' },
      { id: 'u-2', name: 'César Flores' },
    ]);

    const tenantPrisma = {
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      getClient: jest.fn().mockReturnValue({
        user: { findMany },
      }),
    };

    const service = new UsersService(tenantPrisma as never);

    const result = await service.findAssignable();

    expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
    expect(tenantPrisma.getClient).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        tenantMemberships: {
          some: { tenantId: 'tenant-1' },
        },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    expect(result).toEqual([
      { id: 'u-1', name: 'Ana Pérez' },
      { id: 'u-2', name: 'César Flores' },
    ]);
  });

  describe('findAssignableDrivers', () => {
    it('returns only active users whose tenant role is a pure driver (read+update, no create/delete), sorted by name', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'driver-1',
          name: 'Bruno Díaz',
          tenantMemberships: [
            membership([
              { subject: 'DeliveryRoute', action: 'read' },
              { subject: 'DeliveryRoute', action: 'update' },
            ]),
          ],
        },
        {
          id: 'manager-1',
          name: 'Alma Ríos',
          tenantMemberships: [
            membership([
              { subject: 'DeliveryRoute', action: 'read' },
              { subject: 'DeliveryRoute', action: 'update' },
              { subject: 'DeliveryRoute', action: 'create' },
            ]),
          ],
        },
        {
          id: 'read-only-1',
          name: 'Caro Meza',
          tenantMemberships: [
            membership([{ subject: 'DeliveryRoute', action: 'read' }]),
          ],
        },
        {
          id: 'superadmin-1',
          name: 'Dani Sol',
          tenantMemberships: [
            membership([{ subject: 'all', action: 'manage' }]),
          ],
        },
      ]);

      const tenantPrisma = {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        getClient: jest.fn().mockReturnValue({
          user: { findMany },
        }),
      };

      const service = new UsersService(tenantPrisma as never);
      const result = await service.findAssignableDrivers();

      expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          isActive: true,
          tenantMemberships: { some: { tenantId: 'tenant-1' } },
        },
        select: {
          id: true,
          name: true,
          tenantMemberships: {
            where: { tenantId: 'tenant-1' },
            select: {
              role: {
                select: {
                  permissions: {
                    select: {
                      permission: { select: { subject: true, action: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(result).toEqual([{ id: 'driver-1', name: 'Bruno Díaz' }]);
    });

    it('excludes a user who holds a manager role in ANY tenant membership, even with a driver role too', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'mixed-1',
          name: 'Fede Cruz',
          tenantMemberships: [
            membership([
              { subject: 'DeliveryRoute', action: 'read' },
              { subject: 'DeliveryRoute', action: 'update' },
            ]),
            membership([{ subject: 'DeliveryRoute', action: 'create' }]),
          ],
        },
      ]);

      const tenantPrisma = {
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        getClient: jest.fn().mockReturnValue({ user: { findMany } }),
      };

      const service = new UsersService(tenantPrisma as never);
      const result = await service.findAssignableDrivers();

      expect(result).toEqual([]);
    });
  });
});
