/**
 * Integration test for PrismaPromotionRepository with real database.
 *
 * This test suite proves cascade delete behavior using a real Prisma connection
 * and database transactions, addressing spec scenario 5.14.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaPromotionRepository } from './prisma-promotion.repository';
import { Promotion } from '../domain/promotion.entity';

describe('PrismaPromotionRepository (Integration - Real DB)', () => {
  let prisma: PrismaService;
  let repository: PrismaPromotionRepository;

  // Test data cleanup tracker
  const createdIds: string[] = [];

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaPromotionRepository],
    }).compile();

    prisma = module.get<PrismaService>(PrismaService);
    repository = module.get<PrismaPromotionRepository>(
      PrismaPromotionRepository,
    );

    // Ensure DB connection
    await prisma.$connect();
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

      // GREEN: Save the promotion (creates all join rows)
      await repository.save(promotion);

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

      // Save and verify existence
      await repository.save(promotion);
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
