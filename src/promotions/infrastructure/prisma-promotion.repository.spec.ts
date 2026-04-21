import { PrismaPromotionRepository } from './prisma-promotion.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

type PrismaRepoMock = {
  promotion: {
    findMany: jest.Mock<Promise<unknown[]>, [Record<string, unknown>]>;
    count: jest.Mock<Promise<number>, [Record<string, unknown>]>;
    delete: jest.Mock<Promise<void>, [{ where: { id: string } }]>;
  };
  promotionTargetItem: { deleteMany: jest.Mock<Promise<unknown>, []> };
  promotionCustomer: { deleteMany: jest.Mock<Promise<unknown>, []> };
  promotionPriceList: { deleteMany: jest.Mock<Promise<unknown>, []> };
  promotionDayOfWeek: { deleteMany: jest.Mock<Promise<unknown>, []> };
  $transaction: jest.Mock;
};

function makePrisma(): PrismaRepoMock {
  return {
    promotion: {
      findMany: jest
        .fn<Promise<unknown[]>, [Record<string, unknown>]>()
        .mockResolvedValue([]),
      count: jest
        .fn<Promise<number>, [Record<string, unknown>]>()
        .mockResolvedValue(0),
      delete: jest
        .fn<Promise<void>, [{ where: { id: string } }]>()
        .mockResolvedValue(undefined),
    },
    promotionTargetItem: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionCustomer: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionPriceList: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionDayOfWeek: { deleteMany: jest.fn<Promise<unknown>, []>() },
    $transaction: jest.fn(),
  };
}

describe('PrismaPromotionRepository', () => {
  describe('findAll()', () => {
    it('should include customerScope in where clause when provided', async () => {
      const prisma = makePrisma();
      const repo = new PrismaPromotionRepository(
        prisma as unknown as PrismaService,
      );

      await repo.findAll({ page: 1, limit: 20, customerScope: 'SPECIFIC' });

      const findManyArgs = prisma.promotion.findMany.mock.calls[0][0];
      const countArgs = prisma.promotion.count.mock.calls[0][0];
      const findManyWhere = findManyArgs.where as Record<string, unknown>;
      const countWhere = countArgs.where as Record<string, unknown>;

      expect(findManyWhere.customerScope).toBe('SPECIFIC');
      expect(countWhere.customerScope).toBe('SPECIFIC');
    });

    it('should compose combined filters (type/status/method/search/customerScope) into query', async () => {
      const prisma = makePrisma();
      const repo = new PrismaPromotionRepository(
        prisma as unknown as PrismaService,
      );

      await repo.findAll({
        page: 2,
        limit: 5,
        type: 'PRODUCT_DISCOUNT',
        status: 'ACTIVE',
        method: 'AUTOMATIC',
        customerScope: 'SPECIFIC',
        search: 'descuento',
        sortBy: 'title',
        sortOrder: 'asc',
      });

      const findManyArgs = prisma.promotion.findMany.mock.calls[0][0];
      const countArgs = prisma.promotion.count.mock.calls[0][0];
      const findManyWhere = findManyArgs.where as Record<string, unknown>;
      const countWhere = countArgs.where as Record<string, unknown>;

      expect(findManyArgs.skip).toBe(5);
      expect(findManyArgs.take).toBe(5);
      expect(findManyArgs.orderBy).toEqual({ title: 'asc' });
      expect(findManyWhere.type).toBe('PRODUCT_DISCOUNT');
      expect(findManyWhere.method).toBe('AUTOMATIC');
      expect(findManyWhere.customerScope).toBe('SPECIFIC');
      expect(findManyWhere.title).toEqual({
        contains: 'descuento',
        mode: 'insensitive',
      });
      expect(Array.isArray(findManyWhere.AND)).toBe(true);

      expect(countWhere.type).toBe('PRODUCT_DISCOUNT');
      expect(countWhere.method).toBe('AUTOMATIC');
      expect(countWhere.customerScope).toBe('SPECIFIC');
    });
  });

  describe('delete()', () => {
    it('should rely on DB cascade by deleting parent promotion row', async () => {
      const prisma = makePrisma();
      const repo = new PrismaPromotionRepository(
        prisma as unknown as PrismaService,
      );

      await repo.delete('promo-1');

      expect(prisma.promotion.delete.mock.calls[0][0]).toEqual({
        where: { id: 'promo-1' },
      });
      expect(prisma.promotionTargetItem.deleteMany.mock.calls.length).toBe(0);
      expect(prisma.promotionCustomer.deleteMany.mock.calls.length).toBe(0);
      expect(prisma.promotionPriceList.deleteMany.mock.calls.length).toBe(0);
      expect(prisma.promotionDayOfWeek.deleteMany.mock.calls.length).toBe(0);
    });
  });
});
