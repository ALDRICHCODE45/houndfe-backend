import { UsersService } from './users.service';

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
});
