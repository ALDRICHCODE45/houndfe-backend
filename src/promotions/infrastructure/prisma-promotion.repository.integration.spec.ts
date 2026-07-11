/**
 * Integration test for PrismaPromotionRepository with real database.
 *
 * This test suite proves cascade delete behavior using a real Prisma
 * connection and database transactions, addressing spec scenario 5.14.
 *
 * ## Test-DB isolation
 *
 * Runs against the dedicated `nest-practice-test` database (NOT the
 * dev DB). Loaded by:
 *
 *   - `jest.integration.config.js` → only this file is matched
 *   - `test/integration/setup/load-env.ts` → sets `DATABASE_URL`
 *   - `test/integration/setup/global-setup.ts` → applies migrations
 *     and seeds the baseline tenant
 *
 * Defensive guards:
 *   - `SKIP_DB_INTEGRATION=1` (or unset DATABASE_URL) → describe is
 *     skipped entirely so the unit config or a CI without a test DB
 *     does not crash with a connection error.
 *   - `afterEach` calls `resetAndSeedBaseline()` so a mid-test
 *     failure cannot leak `promotion` rows from one test into the
 *     next. The previous tracked-`createdIds` cleanup was fragile —
 *     a throw inside the tracked code path would skip the cleanup
 *     block and pollute the test DB.
 */
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../../test/integration/reset-db';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaPromotionRepository } from './prisma-promotion.repository';
import { Promotion } from '../domain/promotion.entity';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { ClsService } from 'nestjs-cls';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

// describe.skip when the test DB is unreachable — `pnpm test:unit`
// boots no DB, and any operator running `pnpm test:integration`
// without first running `pnpm run test:db:up` gets a clear message
// from load-env.ts/global-setup.ts rather than a misleading failure.
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaPromotionRepository (Integration - Real DB)', () => {
  let prisma: PrismaService;
  let repository: PrismaPromotionRepository;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    // Wipe state from any previous run, then re-seed the baseline
    // tenant (idempotent — globalSetup already did this once at
    // suite boot, but per-suite the contract is "I own this row
    // before I touch anything").
    await resetAndSeedBaseline();

    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      throw new Error(
        'No tenant found for integration test. globalSetup must have seeded one — ' +
          'verify .env.test and that `pnpm run test:db:up` has the container running.',
      );
    }
    tenantId = tenant.id;

    const cls: Pick<ClsService<TenantClsStore>, 'get'> = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    };

    const tenantPrisma = new TenantPrismaService(
      // The `cls` mock satisfies `ClsService<TenantClsStore>`; the
      // cast is the same one used elsewhere in the integration
      // spec surface (see e4-concurrent-stock-alert.spec.ts).
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls as ClsService<TenantClsStore>,
    );
    repository = new PrismaPromotionRepository(tenantPrisma);
  });

  afterEach(async () => {
    // Robust cascade reset — wipes the promotion rows this spec
    // creates plus every related join table. Re-seeds the baseline
    // tenant so the very next test starts from a clean slate. This
    // replaces the previous tracked-id cleanup that could leak rows
    // on a mid-test failure.
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  describe('save() - Transaction visibility regression', () => {
    it('should create a promotion without failing on findUniqueOrThrow inside transaction', async () => {
      const promotion = Promotion.create({
        id: crypto.randomUUID(),
        title: 'Save Regression P2025',
        type: 'ORDER_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'FIXED',
        discountValue: 1000,
      });

      const saved = await repository.save(promotion);

      expect(saved.id).toBe(promotion.id);
      expect(saved.title).toBe('Save Regression P2025');

      const persisted = await prisma.promotion.findUnique({
        where: { id: promotion.id },
      });
      expect(persisted).not.toBeNull();
    });
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

      // GREEN: Seed promotion rows directly in DB for this integration
      // scenario
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
    });

    it('should return null when attempting to find a deleted promotion', async () => {
      // TRIANGULATION: Different path - verify repository findById after
      // delete
      const promotion = Promotion.create({
        id: crypto.randomUUID(),
        title: 'Find After Delete Test',
        type: 'ORDER_DISCOUNT',
        method: 'MANUAL',
        discountType: 'FIXED',
        discountValue: 500,
      });

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
    });
  });
});
