import { PrismaEmployeeRepository } from './prisma-employee.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

type PrismaRepoMock = {
  employee: {
    findMany: jest.Mock<Promise<unknown[]>, [Record<string, unknown>]>;
    count: jest.Mock<Promise<number>, [Record<string, unknown>]>;
    findUnique: jest.Mock<
      Promise<unknown | null>,
      [{ where: { id: string } }]
    >;
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    update: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    delete: jest.Mock<Promise<void>, [{ where: { id: string } }]>;
    deleteMany: jest.Mock<
      Promise<{ count: number }>,
      [Record<string, unknown>]
    >;
  };
  $transaction: jest.Mock;
};

function makePrisma(): PrismaRepoMock {
  return {
    employee: {
      findMany: jest
        .fn<Promise<unknown[]>, [Record<string, unknown>]>()
        .mockResolvedValue([]),
      count: jest
        .fn<Promise<number>, [Record<string, unknown>]>()
        .mockResolvedValue(0),
      findUnique: jest
        .fn<Promise<unknown | null>, [{ where: { id: string } }]>()
        .mockResolvedValue(null),
      create: jest
        .fn<Promise<unknown>, [Record<string, unknown>]>()
        .mockResolvedValue({}),
      update: jest
        .fn<Promise<unknown>, [Record<string, unknown>]>()
        .mockResolvedValue({}),
      delete: jest
        .fn<Promise<void>, [{ where: { id: string } }]>()
        .mockResolvedValue(undefined),
      deleteMany: jest
        .fn<Promise<{ count: number }>, [Record<string, unknown>]>()
        .mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
}

function makeTenantPrismaMock() {
  const client = makePrisma();
  const tenantPrisma: Pick<TenantPrismaService, 'getClient'> & {
    client: PrismaRepoMock;
  } = {
    getClient: jest.fn().mockReturnValue(client),
    client,
  };

  return tenantPrisma;
}

describe('PrismaEmployeeRepository', () => {
  describe('deleteMany()', () => {
    it('passes the id list into prisma.employee.deleteMany', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.employee.deleteMany.mockResolvedValue({ count: 3 });
      const repo = new PrismaEmployeeRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany(['a', 'b', 'c']);

      expect(deleted).toBe(3);
      expect(prisma.employee.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b', 'c'] } },
      });
    });

    it('short-circuits to 0 for an empty list (no DB roundtrip)', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaEmployeeRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany([]);

      expect(deleted).toBe(0);
      expect(prisma.employee.deleteMany).not.toHaveBeenCalled();
    });

    it('returns the count of rows actually removed', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.employee.deleteMany.mockResolvedValue({ count: 0 });
      const repo = new PrismaEmployeeRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany(['non-existent']);

      expect(deleted).toBe(0);
    });

    it('uses tenantPrisma.getClient() so the ambient CLS tx wraps the delete', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const repo = new PrismaEmployeeRepository(
        tenantPrisma as TenantPrismaService,
      );

      await repo.deleteMany(['x']);

      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });
  });
});
