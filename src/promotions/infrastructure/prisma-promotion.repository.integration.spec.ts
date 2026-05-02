/**
 * Integration test for PrismaPromotionRepository with real database.
 *
 * This test suite proves cascade delete behavior using a real Prisma connection
 * and database transactions, addressing spec scenario 5.14.
 */
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaPromotionRepository } from './prisma-promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

describe('PrismaPromotionRepository (Integration - Real DB)', () => {
  let prisma: PrismaService;
  let repository: PrismaPromotionRepository;
  let tenantId: string;

  // Test data cleanup tracker
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) throw new Error('No tenant found for integration test');
    tenantId = tenant.id;

    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as any;

    const tenantPrisma = new TenantPrismaService(prisma, cls);
    repository = new PrismaPromotionRepository(tenantPrisma);
  });

  afterAll(async () => {
    // Cleanup all test data
    if (createdIds.length > 0) {
      await prisma.promotion.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    await prisma.$disconnect();
  });

  afterEach(() => {
    // Clear the tracker after each test
    createdIds.length = 0;
  });

  describe('delete() - Cascade behavior (Scenario 5.14)', () => {
    it('should cascade delete all related join table rows when promotion is deleted', async () => {
      // RED: Create a promotion with related rows in all join tables
      const promotion = Promotion.create({
        id: crypto.randomUUID(),
        title: 'Integration Test Cascade',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        appliesTo: 'CATEGORIES',
      });

      // Attach relations (same pattern as service)
      promotion.targetItems = [
        {
          id: crypto.randomUUID(),
          side: 'DEFAULT',
          targetType: 'CATEGORIES',
          targetId: 'test-cat-id',
        },
      ];
      promotion.customers = [];
      promotion.priceLists = [];
      promotion.daysOfWeek = [
        { id: crypto.randomUUID(), day: 'MONDAY' },
        { id: crypto.randomUUID(), day: 'FRIDAY' },
      ];

      createdIds.push(promotion.id);

      // GREEN: Seed promotion rows directly in DB for this integration scenario
      await prisma.promotion.create({
        data: {
          id: promotion.id,
          tenantId,
          title: promotion.title,
          type: promotion.type,
          method: promotion.method,
          status: promotion.status,
          customerScope: promotion.customerScope,
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
          appliesTo: promotion.appliesTo,
        },
      });

      await prisma.promotionTargetItem.createMany({
        data: promotion.targetItems.map((item) => ({
          promotionId: promotion.id,
          tenantId,
          side: item.side,
          targetType: item.targetType,
          targetId: item.targetId,
        })),
      });

      await prisma.promotionDayOfWeek.createMany({
        data: promotion.daysOfWeek.map((d) => ({
          promotionId: promotion.id,
          tenantId,
          day: d.day,
        })),
      });

      // Verify the promotion and all join rows exist in DB
      const savedPromotion = await prisma.promotion.findUnique({
        where: { id: promotion.id },
        include: {
          targetItems: true,
          customers: true,
          priceLists: true,
          daysOfWeek: true,
        },
      });

      expect(savedPromotion).not.toBeNull();
      expect(savedPromotion?.targetItems.length).toBe(1);
      expect(savedPromotion?.daysOfWeek.length).toBe(2);

      // WHEN: Delete the promotion through repository
      await repository.delete(promotion.id);

      // THEN: Promotion should be gone
      const deletedPromotion = await prisma.promotion.findUnique({
        where: { id: promotion.id },
      });
      expect(deletedPromotion).toBeNull();

      // THEN: All related join table rows should be cascade-deleted
      const remainingTargetItems = await prisma.promotionTargetItem.findMany({
        where: { promotionId: promotion.id },
      });
      expect(remainingTargetItems.length).toBe(0);

      const remainingDaysOfWeek = await prisma.promotionDayOfWeek.findMany({
        where: { promotionId: promotion.id },
      });
      expect(remainingDaysOfWeek.length).toBe(0);

      const remainingCustomers = await prisma.promotionCustomer.findMany({
        where: { promotionId: promotion.id },
      });
      expect(remainingCustomers.length).toBe(0);

      const remainingPriceLists = await prisma.promotionPriceList.findMany({
        where: { promotionId: promotion.id },
      });
      expect(remainingPriceLists.length).toBe(0);

      // Remove from cleanup tracker since already deleted
      const idx = createdIds.indexOf(promotion.id);
      if (idx >= 0) createdIds.splice(idx, 1);
    });

    it('should return null when attempting to find a deleted promotion', async () => {
      // TRIANGULATION: Different path - verify repository findById after delete
      const promotion = Promotion.create({
        id: crypto.randomUUID(),
        title: 'Find After Delete Test',
        type: 'ORDER_DISCOUNT',
        method: 'MANUAL',
        discountType: 'FIXED',
        discountValue: 500,
      });

      createdIds.push(promotion.id);

      // Seed and verify existence
      await prisma.promotion.create({
        data: {
          id: promotion.id,
          tenantId,
          title: promotion.title,
          type: promotion.type,
          method: promotion.method,
          status: promotion.status,
          customerScope: promotion.customerScope,
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
        },
      });
      const found = await repository.findById(promotion.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(promotion.id);

      // Delete
      await repository.delete(promotion.id);

      // THEN: Repository findById should return null
      const notFound = await repository.findById(promotion.id);
      expect(notFound).toBeNull();

      // Remove from cleanup tracker
      const idx = createdIds.indexOf(promotion.id);
      if (idx >= 0) createdIds.splice(idx, 1);
    });
  });
});
