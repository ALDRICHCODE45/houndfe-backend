/**
 * Integration spec for PrismaPromotionUsageRepository against real PostgreSQL.
 *
 * Exercises the ambient-tx capacity ledger end-to-end so the
 * ledger-first `createMany` gate, the tenant-qualified conditional raw
 * UPDATE, and the int32-overflow guard run exactly as in production.
 *
 * Seven scenarios from pca-2c1b:
 *   1. exact same-sale retry => one usage row, one counter increment
 *   2. unlimited claim (maxProductUnits null) increments history
 *   3. exact cap fit
 *   4. multi-promotion later over-cap => entire tx rollback
 *   5. concurrent two-sales final-unit race => one success, one typed
 *      capacity error, counter pinned at cap, one ledger row
 *   6. unlimited counter at PostgreSQL int32 max rejects +1 as typed
 *      capacity error with ledger rollback
 *   7. tenant-scoped claims cannot consume a foreign promotion
 *
 * Seven restoration scenarios from pca-2d1b:
 *   8. same-sale restore retry decrements capacity exactly once and is
 *      a no-op on repeat
 *   9. one multi-promotion sale restores every counter and stamps every row
 *   10. a partial ledger restores only the remaining active row
 *   11. a forced counter mismatch rolls the whole ambient transaction back,
 *      and a repaired fixture retry succeeds
 *   12. concurrent restores settle once without double-decrement
 *   13. a foreign tenant cannot restore the owning tenant's ledger/counter
 *   14. a corrupted zero/insufficient counter never goes negative
 *
 * Six near-capacity outbox scenarios from pca-3b2, proving the just-committed
 * `promotion.near_capacity.detected` transactional-outbox semantics against a
 * real database rather than a mocked writer:
 *   15. a finite exact-boundary claim (79->80 of 100) writes one PENDING row
 *       whose aggregate, event type, and raw payload values are exact
 *   16. below-threshold, already-at-threshold, and unlimited claims emit none
 *   17. a same-sale retry after a crossing stays one ledger row and one event
 *   18. concurrent different-sale claims from 79 serialize to 81 and emit
 *       exactly one crossing event, owned by the 79->80 winner
 *   19. a later over-cap promotion rolls back the earlier crossing counter,
 *       ledger row, and outbox row with the whole ambient transaction
 *   20. `restoreForSale` returns the counter to 79 without emitting, and a
 *       later sale re-crosses with a second event
 *
 * Loaded by `jest.integration.config.js`. Gated by `DATABASE_URL` and
 * `SKIP_DB_INTEGRATION`. Every fixture and assertion query is tenant
 * qualified on `BASELINE_TENANT_ID`.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { PrismaPromotionUsageRepository } from './prisma-promotion-usage.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type { PromotionCapacityClaim } from '../domain/promotion-usage.repository';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';

const unavailable =
  !process.env.DATABASE_URL || process.env.SKIP_DB_INTEGRATION === '1';
const describeIfDb = unavailable ? describe.skip : describe;

const PG_INT_MAX = 2_147_483_647;

// `OutboxWriterService` is stateless (no fields), so one shared instance is
// safe across every repository constructed by this spec.
const outboxWriter = new OutboxWriterService();

function makeCls(
  tenantId: string = BASELINE_TENANT_ID,
): ClsService<TenantClsStore> {
  const store = new Map<string, unknown>([['tenantId', tenantId]]);
  const cls = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
  return cls as unknown as ClsService<TenantClsStore>;
}

async function seedSale(prisma: PrismaClient): Promise<{ saleId: string }> {
  const userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@pca.test`,
      hashedPassword: 'test',
      name: 'Capacity test user',
    },
  });
  const saleId = randomUUID();
  await prisma.sale.create({
    data: {
      id: saleId,
      userId,
      tenantId: BASELINE_TENANT_ID,
      status: 'CONFIRMED',
      channel: 'ONLINE',
    },
  });
  return { saleId };
}

async function seedPromotion(
  prisma: PrismaClient,
  overrides: {
    maxProductUnits?: number | null;
    consumedProductUnits?: number;
  } = {},
): Promise<{ promotionId: string }> {
  const promotionId = randomUUID();
  await prisma.promotion.create({
    data: {
      id: promotionId,
      tenantId: BASELINE_TENANT_ID,
      title: `Capacity ${promotionId.slice(0, 8)}`,
      type: 'ORDER_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'FIXED',
      discountValue: 100,
      maxProductUnits: overrides.maxProductUnits ?? null,
      consumedProductUnits: overrides.consumedProductUnits ?? 0,
    },
  });
  return { promotionId };
}

function usageCount(
  prisma: PrismaClient,
  saleId: string,
  promotionId: string,
): Promise<number> {
  return prisma.promotionUsage.count({
    where: {
      tenantId: BASELINE_TENANT_ID,
      saleId,
      promotionId,
    },
  });
}

async function consumedFor(
  prisma: PrismaClient,
  promotionId: string,
  tenantId = BASELINE_TENANT_ID,
): Promise<number> {
  const row = await prisma.promotion.findFirstOrThrow({
    where: { id: promotionId, tenantId },
    select: { consumedProductUnits: true },
  });
  return row.consumedProductUnits;
}

async function seedUsage(
  prisma: PrismaClient,
  saleId: string,
  promotionId: string,
  units: number,
  restoredAt: Date | null,
): Promise<void> {
  await prisma.promotionUsage.create({
    data: {
      tenantId: BASELINE_TENANT_ID,
      saleId,
      promotionId,
      units,
      restoredAt,
    },
  });
}

async function restoredAtFor(
  prisma: PrismaClient,
  saleId: string,
  promotionId: string,
): Promise<Date | null> {
  const row = await prisma.promotionUsage.findFirstOrThrow({
    where: { tenantId: BASELINE_TENANT_ID, saleId, promotionId },
    select: { restoredAt: true },
  });
  return row.restoredAt;
}

const NEAR_CAPACITY_EVENT_TYPE = 'promotion.near_capacity.detected';

interface NearCapacityPayload {
  tenantId: string;
  promotionId: string;
  saleId: string;
  previousConsumedProductUnits: number;
  consumedProductUnits: number;
  maxProductUnits: number;
  occurredAt: string;
}

interface NearCapacityEventRow {
  status: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: NearCapacityPayload;
}

/**
 * Reads only this spec's event type, tenant qualified and ordered by the
 * database (creation order, then id as a tie-breaker), so the assertions never
 * depend on client-side ordering. `payload` is a `Json` column; the captured
 * value is narrowed to the writer's known shape after retrieval, and callers
 * still compare the raw stored JSON with `toEqual`.
 */
async function nearCapacityEvents(
  prisma: PrismaClient,
  promotionId: string,
): Promise<NearCapacityEventRow[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      tenantId: BASELINE_TENANT_ID,
      eventType: NEAR_CAPACITY_EVENT_TYPE,
      aggregateId: promotionId,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      status: true,
      aggregateType: true,
      aggregateId: true,
      eventType: true,
      payload: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    payload: row.payload as unknown as NearCapacityPayload,
  }));
}

function tenantHarness(
  prisma: PrismaClient,
  tenantId: string = BASELINE_TENANT_ID,
): {
  tenantPrisma: TenantPrismaService;
  repository: PrismaPromotionUsageRepository;
} {
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    makeCls(tenantId),
  );
  return {
    tenantPrisma,
    repository: new PrismaPromotionUsageRepository(tenantPrisma, outboxWriter),
  };
}

describeIfDb(
  'PrismaPromotionUsageRepository capacity ledger (PostgreSQL)',
  () => {
    let prisma: PrismaClient;
    let repository: PrismaPromotionUsageRepository;
    let tenantPrisma: TenantPrismaService;

    beforeAll(async () => {
      prisma = integrationPrisma();
      await prisma.$connect();
      await resetAndSeedBaseline();

      const cls = makeCls();
      tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      repository = new PrismaPromotionUsageRepository(
        tenantPrisma,
        outboxWriter,
      );
    });

    beforeEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      await disconnectIntegrationPrisma();
    });

    it('1) exact same-sale retry collapses to one usage row and one counter increment', async () => {
      const { saleId } = await seedSale(prisma);
      const { promotionId } = await seedPromotion(prisma, {
        maxProductUnits: 100,
        consumedProductUnits: 0,
      });

      await tenantPrisma.runInTransaction(async () => {
        await repository.claimForSale(saleId, [{ promotionId, units: 2 }]);
      });
      await tenantPrisma.runInTransaction(async () => {
        await repository.claimForSale(saleId, [{ promotionId, units: 2 }]);
      });

      expect(await usageCount(prisma, saleId, promotionId)).toBe(1);
      expect(await consumedFor(prisma, promotionId)).toBe(2);
    });

    it('2) unlimited claim (maxProductUnits null) increments history across distinct sales', async () => {
      const { saleId: saleA } = await seedSale(prisma);
      const { saleId: saleB } = await seedSale(prisma);
      const { promotionId } = await seedPromotion(prisma, {
        maxProductUnits: null,
      });

      await tenantPrisma.runInTransaction(async () => {
        await repository.claimForSale(saleA, [{ promotionId, units: 1 }]);
      });
      await tenantPrisma.runInTransaction(async () => {
        await repository.claimForSale(saleB, [{ promotionId, units: 4 }]);
      });

      expect(await consumedFor(prisma, promotionId)).toBe(5);
      const history = await prisma.promotionUsage.findMany({
        where: {
          tenantId: BASELINE_TENANT_ID,
          promotionId,
          restoredAt: null,
        },
        select: { saleId: true, units: true },
      });
      expect(history).toHaveLength(2);
      expect(history.map((row) => row.units).sort((a, b) => a - b)).toEqual([
        1, 4,
      ]);
    });

    it('3) exact cap fit lands at max without over-incrementing', async () => {
      const { saleId } = await seedSale(prisma);
      const { promotionId } = await seedPromotion(prisma, {
        maxProductUnits: 10,
        consumedProductUnits: 8,
      });

      await tenantPrisma.runInTransaction(async () => {
        await repository.claimForSale(saleId, [{ promotionId, units: 2 }]);
      });

      expect(await consumedFor(prisma, promotionId)).toBe(10);
      expect(await usageCount(prisma, saleId, promotionId)).toBe(1);
    });

    it('4) later over-cap claim rolls back earlier counters and the whole ledger', async () => {
      const { saleId } = await seedSale(prisma);
      const { promotionId: promoA } = await seedPromotion(prisma, {
        maxProductUnits: 10,
        consumedProductUnits: 0,
      });
      const { promotionId: promoB } = await seedPromotion(prisma, {
        maxProductUnits: 5,
        consumedProductUnits: 4,
      });

      const claims: PromotionCapacityClaim[] = [
        { promotionId: promoA, units: 1 },
        { promotionId: promoB, units: 2 },
      ];

      await expect(
        tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, claims);
        }),
      ).rejects.toMatchObject({ code: 'PROMOTION_CAPACITY_EXCEEDED' });

      expect(await consumedFor(prisma, promoA)).toBe(0);
      expect(await consumedFor(prisma, promoB)).toBe(4);
      expect(await usageCount(prisma, saleId, promoA)).toBe(0);
      expect(await usageCount(prisma, saleId, promoB)).toBe(0);
    });

    it('5) concurrent final-unit race resolves to one success, one typed capacity error, cap held', async () => {
      const { saleId: saleA } = await seedSale(prisma);
      const { saleId: saleB } = await seedSale(prisma);
      const { promotionId } = await seedPromotion(prisma, {
        maxProductUnits: 10,
        consumedProductUnits: 9,
      });

      // Independent CLS stores per transaction so parallel runs cannot
      // clobber the TX_CLIENT_KEY slot the SUT reads through.
      const clsA = makeCls();
      const tpA = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        clsA as unknown as ClsService<TenantClsStore>,
      );
      const repoA = new PrismaPromotionUsageRepository(tpA, outboxWriter);
      const clsB = makeCls();
      const tpB = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        clsB as unknown as ClsService<TenantClsStore>,
      );
      const repoB = new PrismaPromotionUsageRepository(tpB, outboxWriter);

      const [first, second] = await Promise.allSettled([
        tpA.runInTransaction(async () => {
          await repoA.claimForSale(saleA, [{ promotionId, units: 1 }]);
        }),
        tpB.runInTransaction(async () => {
          await repoB.claimForSale(saleB, [{ promotionId, units: 1 }]);
        }),
      ]);

      const outcomes = [first, second];
      const fulfilled = outcomes.filter(
        (o): o is PromiseFulfilledResult<void> => o.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BusinessRuleViolationError);
      expect((rejected[0].reason as BusinessRuleViolationError).code).toBe(
        'PROMOTION_CAPACITY_EXCEEDED',
      );

      expect(await consumedFor(prisma, promotionId)).toBe(10);
      const rows = await prisma.promotionUsage.findMany({
        where: {
          tenantId: BASELINE_TENANT_ID,
          promotionId,
          restoredAt: null,
        },
        select: { saleId: true, units: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].units).toBe(1);
    });

    it('6) unlimited counter at PG int32 max rejects +1 with typed capacity error and rolls back ledger', async () => {
      const { saleId } = await seedSale(prisma);
      const { promotionId } = await seedPromotion(prisma, {
        maxProductUnits: null,
        consumedProductUnits: PG_INT_MAX,
      });

      let failure: unknown;
      try {
        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 1 }]);
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BusinessRuleViolationError);
      expect(failure).toMatchObject({ code: 'PROMOTION_CAPACITY_EXCEEDED' });

      expect(await consumedFor(prisma, promotionId)).toBe(PG_INT_MAX);
      expect(await usageCount(prisma, saleId, promotionId)).toBe(0);
    });

    it('7) tenant scope rejects a foreign promotion without changing its counter', async () => {
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: `Capacity tenant ${foreignTenantId.slice(0, 8)}`,
          slug: `capacity-${foreignTenantId}`,
        },
      });
      const foreignPromotionId = randomUUID();
      await prisma.promotion.create({
        data: {
          id: foreignPromotionId,
          tenantId: foreignTenantId,
          title: 'Foreign capacity promotion',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          maxProductUnits: 10,
        },
      });
      const { saleId } = await seedSale(prisma);

      let failure: unknown;
      try {
        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [
            { promotionId: foreignPromotionId, units: 1 },
          ]);
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(failure).toMatchObject({ code: 'P2003' });

      expect(
        await consumedFor(prisma, foreignPromotionId, foreignTenantId),
      ).toBe(0);
      expect(
        await prisma.promotionUsage.count({
          where: {
            tenantId: BASELINE_TENANT_ID,
            saleId,
            promotionId: foreignPromotionId,
          },
        }),
      ).toBe(0);
      expect(
        await prisma.promotionUsage.count({
          where: {
            tenantId: foreignTenantId,
            saleId,
            promotionId: foreignPromotionId,
          },
        }),
      ).toBe(0);
    });

    describe('restoration (pca-2d1b)', () => {
      it('8) same-sale restore decrements exactly once and repeated calls are no-ops', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 0,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 2 }]);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(2);

        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleId);
        });
        const firstRestore = await restoredAtFor(prisma, saleId, promotionId);
        expect(firstRestore).not.toBeNull();
        expect(await consumedFor(prisma, promotionId)).toBe(0);

        // Retry after the row is already stamped must not decrement again.
        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleId);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, promotionId)).toEqual(
          firstRestore,
        );
        expect(await usageCount(prisma, saleId, promotionId)).toBe(1);
      });

      it('9) one multi-promotion sale restores every counter and stamps every ledger row', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId: promoA } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 0,
        });
        const { promotionId: promoB } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 0,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [
            { promotionId: promoA, units: 2 },
            { promotionId: promoB, units: 3 },
          ]);
        });
        expect(await consumedFor(prisma, promoA)).toBe(2);
        expect(await consumedFor(prisma, promoB)).toBe(3);

        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleId);
        });

        expect(await consumedFor(prisma, promoA)).toBe(0);
        expect(await consumedFor(prisma, promoB)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, promoA)).not.toBeNull();
        expect(await restoredAtFor(prisma, saleId, promoB)).not.toBeNull();
      });

      it('10) a partial ledger restores only the remaining active row without double-decrement', async () => {
        const { saleId } = await seedSale(prisma);
        const priorRestore = new Date('2020-01-01T00:00:00.000Z');
        const { promotionId: promoActive } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 3,
        });
        const { promotionId: promoRestored } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 0,
        });
        await seedUsage(prisma, saleId, promoActive, 3, null);
        await seedUsage(prisma, saleId, promoRestored, 5, priorRestore);

        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleId);
        });

        expect(await consumedFor(prisma, promoActive)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, promoActive)).not.toBeNull();
        // The already-restored row is skipped: counter stays at zero and its
        // original stamp is preserved rather than overwritten with NOW().
        expect(await consumedFor(prisma, promoRestored)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, promoRestored)).toEqual(
          priorRestore,
        );
      });

      it('11) a forced counter mismatch rolls back the whole restore and a repaired retry succeeds', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId: promoFirst } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 0,
        });
        const { promotionId: promoSecond } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 0,
        });
        // The repository processes active rows in ascending promotionId order,
        // so the first id is stamped and decremented before the mismatch hits.
        const [winnerId, loserId] = [promoFirst, promoSecond].sort();
        await seedUsage(prisma, saleId, winnerId, 2, null);
        await seedUsage(prisma, saleId, loserId, 5, null);
        await prisma.promotion.update({
          where: { id: winnerId },
          data: { consumedProductUnits: 2 },
        });
        await prisma.promotion.update({
          where: { id: loserId },
          data: { consumedProductUnits: 1 },
        });

        await expect(
          tenantPrisma.runInTransaction(async () => {
            await repository.restoreForSale(saleId);
          }),
        ).rejects.toMatchObject({
          code: 'PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH',
          details: { saleId, promotionId: loserId, units: 5 },
        });

        // Atomic rollback: the winner's earlier stamp and decrement are gone.
        expect(await consumedFor(prisma, winnerId)).toBe(2);
        expect(await consumedFor(prisma, loserId)).toBe(1);
        expect(await restoredAtFor(prisma, saleId, winnerId)).toBeNull();
        expect(await restoredAtFor(prisma, saleId, loserId)).toBeNull();

        // Repair the fixture and prove a valid retry can still succeed.
        await prisma.promotion.update({
          where: { id: loserId },
          data: { consumedProductUnits: 5 },
        });
        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleId);
        });

        expect(await consumedFor(prisma, winnerId)).toBe(0);
        expect(await consumedFor(prisma, loserId)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, winnerId)).not.toBeNull();
        expect(await restoredAtFor(prisma, saleId, loserId)).not.toBeNull();
      });

      it('12) concurrent restores for one sale settle once without double-decrement', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 0,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 4 }]);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(4);

        // Independent CLS stores per transaction so parallel runs cannot
        // clobber the TX_CLIENT_KEY slot the SUT reads through.
        const first = tenantHarness(prisma);
        const second = tenantHarness(prisma);
        const outcomes = await Promise.allSettled([
          first.tenantPrisma.runInTransaction(async () => {
            await first.repository.restoreForSale(saleId);
          }),
          second.tenantPrisma.runInTransaction(async () => {
            await second.repository.restoreForSale(saleId);
          }),
        ]);

        // Winner identity is deliberately unasserted: only one caller can win
        // the stamp race, and both settle without a double-decrement.
        expect(
          outcomes.every((outcome) => outcome.status === 'fulfilled'),
        ).toBe(true);
        expect(await consumedFor(prisma, promotionId)).toBe(0);
        expect(await restoredAtFor(prisma, saleId, promotionId)).not.toBeNull();
        expect(await usageCount(prisma, saleId, promotionId)).toBe(1);
      });

      it('13) a foreign tenant cannot restore or alter the owning tenant ledger or counter', async () => {
        const foreignTenantId = randomUUID();
        await prisma.tenant.create({
          data: {
            id: foreignTenantId,
            name: `Restore tenant ${foreignTenantId.slice(0, 8)}`,
            slug: `restore-${foreignTenantId}`,
          },
        });
        const { saleId } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 50,
          consumedProductUnits: 3,
        });
        await seedUsage(prisma, saleId, promotionId, 3, null);

        const foreign = tenantHarness(prisma, foreignTenantId);
        await foreign.tenantPrisma.runInTransaction(async () => {
          await foreign.repository.restoreForSale(saleId);
        });

        expect(await consumedFor(prisma, promotionId)).toBe(3);
        expect(await restoredAtFor(prisma, saleId, promotionId)).toBeNull();
        expect(
          await prisma.promotionUsage.count({
            where: { tenantId: foreignTenantId },
          }),
        ).toBe(0);
      });

      it.each<[number]>([[0], [1]])(
        '14) a corrupted counter of %i never goes negative, throws the typed mismatch, and leaves restoredAt null',
        async (corruptedCounter) => {
          const { saleId } = await seedSale(prisma);
          const { promotionId } = await seedPromotion(prisma, {
            maxProductUnits: 50,
            consumedProductUnits: corruptedCounter,
          });
          await seedUsage(prisma, saleId, promotionId, 3, null);

          let failure: unknown;
          try {
            await tenantPrisma.runInTransaction(async () => {
              await repository.restoreForSale(saleId);
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toMatchObject({
            code: 'PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH',
          });

          expect(await consumedFor(prisma, promotionId)).toBe(corruptedCounter);
          expect(await restoredAtFor(prisma, saleId, promotionId)).toBeNull();
        },
      );
    });

    describe('near-capacity outbox emission (pca-3b2)', () => {
      it('15) an exact 79->80 boundary claim writes one PENDING row with exact payload values', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 79,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 1 }]);
        });

        expect(await consumedFor(prisma, promotionId)).toBe(80);
        const events = await nearCapacityEvents(prisma, promotionId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          status: 'PENDING',
          aggregateType: 'Promotion',
          aggregateId: promotionId,
          eventType: NEAR_CAPACITY_EVENT_TYPE,
        });
        const { occurredAt } = events[0].payload;
        expect(new Date(occurredAt).toISOString()).toBe(occurredAt);
        expect(events[0].payload).toEqual({
          tenantId: BASELINE_TENANT_ID,
          promotionId,
          saleId,
          previousConsumedProductUnits: 79,
          consumedProductUnits: 80,
          maxProductUnits: 100,
          occurredAt,
        });
      });

      it('16) below-threshold, at-threshold, and unlimited claims emit no capacity row', async () => {
        const { saleId: belowSale } = await seedSale(prisma);
        const { saleId: atThresholdSale } = await seedSale(prisma);
        const { saleId: unlimitedSale } = await seedSale(prisma);
        const { promotionId: belowPromotion } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 70,
        });
        const { promotionId: atThresholdPromotion } = await seedPromotion(
          prisma,
          { maxProductUnits: 100, consumedProductUnits: 80 },
        );
        const { promotionId: unlimitedPromotion } = await seedPromotion(
          prisma,
          { maxProductUnits: null, consumedProductUnits: 100 },
        );

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(belowSale, [
            { promotionId: belowPromotion, units: 5 },
          ]);
        });
        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(atThresholdSale, [
            { promotionId: atThresholdPromotion, units: 5 },
          ]);
        });
        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(unlimitedSale, [
            { promotionId: unlimitedPromotion, units: 10 },
          ]);
        });

        expect(await consumedFor(prisma, belowPromotion)).toBe(75);
        expect(await consumedFor(prisma, atThresholdPromotion)).toBe(85);
        expect(await consumedFor(prisma, unlimitedPromotion)).toBe(110);
        expect(await nearCapacityEvents(prisma, belowPromotion)).toHaveLength(
          0,
        );
        expect(
          await nearCapacityEvents(prisma, atThresholdPromotion),
        ).toHaveLength(0);
        expect(
          await nearCapacityEvents(prisma, unlimitedPromotion),
        ).toHaveLength(0);
        expect(
          await prisma.outboxEvent.count({
            where: {
              tenantId: BASELINE_TENANT_ID,
              eventType: NEAR_CAPACITY_EVENT_TYPE,
            },
          }),
        ).toBe(0);
      });

      it('17) a same-sale retry after a crossing stays one increment and one event', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 79,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 1 }]);
        });
        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleId, [{ promotionId, units: 1 }]);
        });

        expect(await consumedFor(prisma, promotionId)).toBe(80);
        expect(await usageCount(prisma, saleId, promotionId)).toBe(1);
        const events = await nearCapacityEvents(prisma, promotionId);
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          saleId,
          previousConsumedProductUnits: 79,
          consumedProductUnits: 80,
        });
      });

      it('18) concurrent different-sale claims from 79 serialize to 81 with one crossing event', async () => {
        const { saleId: saleA } = await seedSale(prisma);
        const { saleId: saleB } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 79,
        });

        // Independent CLS stores per transaction so parallel runs cannot
        // clobber the TX_CLIENT_KEY slot the SUT reads through.
        const first = tenantHarness(prisma);
        const second = tenantHarness(prisma);
        const outcomes = await Promise.allSettled([
          first.tenantPrisma.runInTransaction(async () => {
            await first.repository.claimForSale(saleA, [
              { promotionId, units: 1 },
            ]);
          }),
          second.tenantPrisma.runInTransaction(async () => {
            await second.repository.claimForSale(saleB, [
              { promotionId, units: 1 },
            ]);
          }),
        ]);

        expect(
          outcomes.every((outcome) => outcome.status === 'fulfilled'),
        ).toBe(true);
        expect(await consumedFor(prisma, promotionId)).toBe(81);
        const ledger = await prisma.promotionUsage.findMany({
          where: {
            tenantId: BASELINE_TENANT_ID,
            promotionId,
            restoredAt: null,
          },
          select: { saleId: true, units: true },
        });
        expect(ledger).toHaveLength(2);
        expect(ledger.map((row) => row.units)).toEqual([1, 1]);

        // Only the 79->80 winner crosses; the 80->81 follower is already at
        // the threshold and must not emit a second event.
        const events = await nearCapacityEvents(prisma, promotionId);
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          previousConsumedProductUnits: 79,
          consumedProductUnits: 80,
        });
        expect([saleA, saleB]).toContain(events[0].payload.saleId);
      });

      it('19) a later over-cap promotion rolls back the earlier crossing counter, ledger, and outbox row', async () => {
        const { saleId } = await seedSale(prisma);
        const { promotionId: promoA } = await seedPromotion(prisma);
        const { promotionId: promoB } = await seedPromotion(prisma);
        // The repository processes ascending promotionId order, so assigning
        // the crossing fixture to the lexicographically first id makes the
        // emission deterministic and the rollback assertion meaningful.
        const [crossingId, failingId] = [promoA, promoB].sort();
        await prisma.promotion.update({
          where: { id: crossingId },
          data: { maxProductUnits: 100, consumedProductUnits: 79 },
        });
        await prisma.promotion.update({
          where: { id: failingId },
          data: { maxProductUnits: 5, consumedProductUnits: 4 },
        });

        await expect(
          tenantPrisma.runInTransaction(async () => {
            await repository.claimForSale(saleId, [
              { promotionId: crossingId, units: 1 },
              { promotionId: failingId, units: 2 },
            ]);
          }),
        ).rejects.toMatchObject({ code: 'PROMOTION_CAPACITY_EXCEEDED' });

        expect(await consumedFor(prisma, crossingId)).toBe(79);
        expect(await consumedFor(prisma, failingId)).toBe(4);
        expect(await usageCount(prisma, saleId, crossingId)).toBe(0);
        expect(await usageCount(prisma, saleId, failingId)).toBe(0);
        expect(await nearCapacityEvents(prisma, crossingId)).toHaveLength(0);
        expect(
          await prisma.outboxEvent.count({
            where: {
              tenantId: BASELINE_TENANT_ID,
              eventType: NEAR_CAPACITY_EVENT_TYPE,
            },
          }),
        ).toBe(0);
      });

      it('20) restore returns to 79 without emitting and a later sale re-crosses with a second event', async () => {
        const { saleId: saleA } = await seedSale(prisma);
        const { saleId: saleB } = await seedSale(prisma);
        const { promotionId } = await seedPromotion(prisma, {
          maxProductUnits: 100,
          consumedProductUnits: 79,
        });

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleA, [{ promotionId, units: 1 }]);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(80);
        expect(await nearCapacityEvents(prisma, promotionId)).toHaveLength(1);

        await tenantPrisma.runInTransaction(async () => {
          await repository.restoreForSale(saleA);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(79);
        expect(await restoredAtFor(prisma, saleA, promotionId)).not.toBeNull();
        expect(await nearCapacityEvents(prisma, promotionId)).toHaveLength(1);

        await tenantPrisma.runInTransaction(async () => {
          await repository.claimForSale(saleB, [{ promotionId, units: 1 }]);
        });
        expect(await consumedFor(prisma, promotionId)).toBe(80);

        const events = await nearCapacityEvents(prisma, promotionId);
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.payload.saleId).sort()).toEqual(
          [saleA, saleB].sort(),
        );
        for (const event of events) {
          expect(event.payload).toMatchObject({
            previousConsumedProductUnits: 79,
            consumedProductUnits: 80,
            maxProductUnits: 100,
          });
        }
        // Restoration never emits: the only rows written are the two crossings.
        const allEvents = await prisma.outboxEvent.findMany({
          where: { tenantId: BASELINE_TENANT_ID },
          select: { eventType: true },
        });
        expect(allEvents).toHaveLength(2);
        expect(
          allEvents.every(
            (event) => event.eventType === NEAR_CAPACITY_EVENT_TYPE,
          ),
        ).toBe(true);
      });
    });
  },
);
