import { PrismaPromotionRepository } from './prisma-promotion.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

type PrismaRepoMock = {
  promotion: {
    findMany: jest.Mock<Promise<unknown[]>, [Record<string, unknown>]>;
    findUnique: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    findUniqueOrThrow: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    upsert: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    updateMany: jest.Mock<
      Promise<{ count: number }>,
      [Record<string, unknown>]
    >;
    count: jest.Mock<Promise<number>, [Record<string, unknown>]>;
    delete: jest.Mock<Promise<void>, [{ where: { id: string } }]>;
    deleteMany: jest.Mock<
      Promise<{ count: number }>,
      [Record<string, unknown>]
    >;
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
      findUnique: jest
        .fn<Promise<unknown>, [Record<string, unknown>]>()
        .mockResolvedValue(null),
      findUniqueOrThrow: jest
        .fn<Promise<unknown>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
      upsert: jest
        .fn<Promise<unknown>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
      updateMany: jest
        .fn<Promise<{ count: number }>, [Record<string, unknown>]>()
        .mockResolvedValue({ count: 1 }),
      count: jest
        .fn<Promise<number>, [Record<string, unknown>]>()
        .mockResolvedValue(0),
      delete: jest
        .fn<Promise<void>, [{ where: { id: string } }]>()
        .mockResolvedValue(undefined),
      deleteMany: jest
        .fn<Promise<{ count: number }>, [Record<string, unknown>]>()
        .mockResolvedValue({ count: 0 }),
    },
    promotionTargetItem: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionCustomer: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionPriceList: { deleteMany: jest.fn<Promise<unknown>, []>() },
    promotionDayOfWeek: { deleteMany: jest.fn<Promise<unknown>, []>() },
    $transaction: jest.fn(),
  };
}

/** Prisma promotion row (with relations); unlimited by default. */
function makePromotionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const timestamp = new Date('2024-01-01T00:00:00.000Z');
  return {
    id: 'promo-1',
    title: 'Persisted Promo',
    type: 'ORDER_DISCOUNT',
    method: 'AUTOMATIC',
    status: 'ACTIVE',
    manuallyEnded: false,
    startDate: null,
    endDate: null,
    customerScope: 'ALL',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minPurchaseAmountCents: null,
    appliesTo: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyTargetType: null,
    getTargetType: null,
    maxProductUnits: null,
    consumedProductUnits: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    tenantId: 'tenant-1',
    ...overrides,
  };
}

type TenantPrismaMock = TenantPrismaService & {
  getClient: jest.Mock;
  getTenantId: jest.Mock;
  runInTransaction: jest.Mock;
  client: PrismaRepoMock;
};

describe('PrismaPromotionRepository', () => {
  function makeTenantPrismaMock(): TenantPrismaMock {
    const client = makePrisma();
    return {
      getClient: jest.fn().mockReturnValue(client),
      getTenantId: jest.fn().mockReturnValue('tenant-1'),
      // Mirrors TenantPrismaService.runInTransaction: runs the work with the
      // same mocked client available through getClient() and records the
      // requested isolation level so tests can assert the forwarded option.
      runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
      client,
    } as unknown as TenantPrismaMock;
  }

  describe('findAll()', () => {
    it('should include customerScope in where clause when provided', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      await repo.findAll({ page: 1, limit: 20, customerScope: 'SPECIFIC' });

      const findManyArgs = prisma.promotion.findMany.mock.calls[0][0];
      const countArgs = prisma.promotion.count.mock.calls[0][0];
      const findManyWhere = findManyArgs.where as Record<string, unknown>;
      const countWhere = countArgs.where as Record<string, unknown>;

      expect(tenantPrisma.getClient).toHaveBeenCalled();
      expect(findManyWhere.customerScope).toBe('SPECIFIC');
      expect(countWhere.customerScope).toBe('SPECIFIC');
    });

    it('should compose combined filters (type/status/method/search/customerScope) into query', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
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

  describe('findActiveAutomaticSnapshot()', () => {
    it('filters on the manual override, not stale persisted status, when selecting effectively active promotions', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.promotion.findMany.mockResolvedValue([
        makePromotionRow({
          id: 'reopened-restricted',
          status: 'ENDED',
          manuallyEnded: false,
          startDate: new Date('2020-01-01T00:00:00.000Z'),
          endDate: new Date('2099-01-01T00:00:00.000Z'),
          customerScope: 'SPECIFIC',
          targetItems: [
            {
              id: 'target-1',
              side: 'DEFAULT',
              targetType: 'PRODUCTS',
              targetId: 'cart-product',
            },
          ],
        }),
      ]);
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const snapshot = await repo.findActiveAutomaticSnapshot();
      const where = prisma.promotion.findMany.mock.calls[0][0].where as Record<
        string,
        unknown
      >;

      // Persisted ENDED can be stale after a date-window change: the domain
      // considers this row active. Conversely, persisted ACTIVE with a manual
      // closure must be excluded by the same predicate.
      expect(where.manuallyEnded).toBe(false);
      expect(where.status).toBeUndefined();
      expect(JSON.stringify(where)).not.toContain('"status"');
      expect(snapshot.complete).toBe(true);
      expect(snapshot.promotions[0].id).toBe('reopened-restricted');
      expect(snapshot.promotions[0].customerScope).toBe('SPECIFIC');
    });

    it('reads one capped id-ordered page in a RepeatableRead transaction without skip or count', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.promotion.findMany.mockResolvedValue([makePromotionRow()]);
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const snapshot = await repo.findActiveAutomaticSnapshot();

      expect(prisma.promotion.findMany.mock.calls.length).toBe(1);
      const args = prisma.promotion.findMany.mock.calls[0][0];
      expect(args.take).toBe(1001);
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(args.skip).toBeUndefined();

      // The whole set is proven by the read alone: no separate count, so no
      // count/read race.
      expect(prisma.promotion.count.mock.calls.length).toBe(0);

      // Effective ACTIVE semantics: only manual closure or a date-window
      // boundary can exclude a row; the persisted status is merely a hint.
      const where = args.where as {
        method?: unknown;
        manuallyEnded?: unknown;
        AND?: unknown[];
      };
      expect(where.method).toBe('AUTOMATIC');
      expect(where.manuallyEnded).toBe(false);
      const and = where.AND as Array<Record<string, unknown>>;
      expect(and).toHaveLength(2);

      const [lower, upper] = and as Array<{
        OR: Array<Record<string, unknown>>;
      }>;
      expect(lower.OR[0]).toEqual({ startDate: null });
      const startBound = lower.OR[1] as { startDate: { lte: Date } };
      expect(startBound.startDate.lte).toBeInstanceOf(Date);
      expect(upper.OR[0]).toEqual({ endDate: null });
      const endBound = upper.OR[1] as { endDate: { gte: Date } };
      expect(endBound.endDate.gte).toBeInstanceOf(Date);

      // Tenant-scoped client, and the isolation level is forwarded explicitly
      // instead of relying on the driver default.
      expect(tenantPrisma.getClient.mock.calls.length).toBe(1);
      const runInTransaction = tenantPrisma.runInTransaction as jest.Mock<
        Promise<unknown>,
        [() => Promise<unknown>, string?]
      >;
      expect(runInTransaction.mock.calls[0][1]).toBe('RepeatableRead');

      expect(snapshot.complete).toBe(true);
      expect(snapshot.promotions.map((p) => p.id)).toEqual(['promo-1']);
    });

    it('returns the joined eligibility relations mapped to the domain entity', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.promotion.findMany.mockResolvedValue([
        makePromotionRow({
          targetItems: [
            {
              id: 'ti-1',
              side: 'DEFAULT',
              targetType: 'PRODUCTS',
              targetId: 'prod-1',
            },
          ],
          customers: [
            {
              id: 'pc-1',
              customerId: 'cust-1',
              customer: { id: 'cust-1', firstName: 'Ana', lastName: null },
            },
          ],
          priceLists: [
            {
              id: 'ppl-1',
              globalPriceListId: 'GPL-1',
              globalPriceList: { id: 'GPL-1', name: 'Retail' },
            },
          ],
          daysOfWeek: [{ id: 'dow-1', day: 'SUNDAY' }],
        }),
      ]);
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const { promotions } = await repo.findActiveAutomaticSnapshot();

      expect(promotions[0].targetItems).toEqual([
        {
          id: 'ti-1',
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: 'prod-1',
        },
      ]);
      expect(promotions[0].customers[0].customerId).toBe('cust-1');
      expect(promotions[0].priceLists[0].globalPriceListId).toBe('GPL-1');
      expect(promotions[0].daysOfWeek[0].day).toBe('SUNDAY');
    });

    it('reports the snapshot complete at exactly the cap and incomplete one row above it', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );
      const rows = (count: number) =>
        Array.from({ length: count }, (_, index) =>
          makePromotionRow({ id: `promo-${String(index).padStart(4, '0')}` }),
        );

      prisma.promotion.findMany.mockResolvedValueOnce(rows(1000));
      const atCap = await repo.findActiveAutomaticSnapshot();

      prisma.promotion.findMany.mockResolvedValueOnce(rows(1001));
      const overCap = await repo.findActiveAutomaticSnapshot();

      expect(atCap.complete).toBe(true);
      expect(atCap.promotions).toHaveLength(1000);

      // The 1001st row is the overload sentinel: it proves the tenant exceeds
      // the owner-approved cap, so the snapshot is incomplete and the returned
      // set stays bounded at the cap.
      expect(overCap.complete).toBe(false);
      expect(overCap.promotions).toHaveLength(1000);
    });
  });

  describe('delete()', () => {
    it('should rely on DB cascade by deleting parent promotion row', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
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

  describe('deleteMany()', () => {
    it('passes the id list into prisma.promotion.deleteMany', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.promotion.deleteMany.mockResolvedValue({ count: 3 });
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany(['a', 'b', 'c']);

      expect(deleted).toBe(3);
      expect(prisma.promotion.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b', 'c'] } },
      });
    });

    it('short-circuits to 0 for an empty list (no DB roundtrip)', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany([]);

      expect(deleted).toBe(0);
      expect(prisma.promotion.deleteMany).not.toHaveBeenCalled();
    });

    it('returns the count of rows actually removed', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.promotion.deleteMany.mockResolvedValue({ count: 0 });
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      const deleted = await repo.deleteMany(['non-existent']);

      expect(deleted).toBe(0);
    });

    it('uses tenantPrisma.getClient() so the ambient CLS tx wraps the delete', async () => {
      const tenantPrisma = makeTenantPrismaMock();
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );

      await repo.deleteMany(['x']);

      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });
  });

  describe('product-unit capacity mapping', () => {
    function makeRepoWithSave(row: Record<string, unknown>) {
      const tenantPrisma = makeTenantPrismaMock();
      const prisma = tenantPrisma.client;
      prisma.$transaction.mockImplementation(
        (callback: (tx: PrismaRepoMock) => Promise<unknown>) =>
          callback(prisma),
      );
      prisma.promotion.findUnique.mockResolvedValue(row);
      prisma.promotion.findUniqueOrThrow.mockResolvedValue(row);
      const repo = new PrismaPromotionRepository(
        tenantPrisma as TenantPrismaService,
      );
      return { repo, prisma };
    }

    it('persists the cap through a guarded updateMany and never overwrites consumed', async () => {
      const { repo, prisma } = makeRepoWithSave(
        makePromotionRow({ maxProductUnits: 30, consumedProductUnits: 7 }),
      );
      const promotion = (await repo.findById('promo-1'))!;

      await repo.save(promotion);

      const upsertArgs = prisma.promotion.upsert.mock.calls[0][0];
      expect(upsertArgs.create).toMatchObject({
        maxProductUnits: 30,
        consumedProductUnits: 7,
      });
      expect(upsertArgs.update).not.toHaveProperty('consumedProductUnits');
      expect(upsertArgs.update).not.toHaveProperty('maxProductUnits');

      expect(prisma.promotion.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'promo-1',
          consumedProductUnits: { lte: 30 },
        },
        data: { maxProductUnits: 30 },
      });
    });
  });
});
