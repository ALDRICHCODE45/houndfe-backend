/**
 * ADAPTER: PrismaPromotionUsageRepository — ambient-tx-only capacity ledger.
 * `getClient()` is non-transactional without an active tx, so entry is guarded;
 * every statement carries `tenantId` explicitly for raw/unextended clients.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type {
  IPromotionUsageRepository,
  PromotionCapacityClaim,
} from '../domain/promotion-usage.repository';

const PG_INT_MAX = 2_147_483_647;

@Injectable()
export class PrismaPromotionUsageRepository implements IPromotionUsageRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outboxWriter: OutboxWriterService,
  ) {}

  async claimForSale(
    saleId: string,
    claims: PromotionCapacityClaim[],
  ): Promise<void> {
    if (!this.tenantPrisma.isInTransaction()) {
      throw new BusinessRuleViolationError(
        'Promotion capacity claims require an active ambient transaction',
        'PROMOTION_CAPACITY_CLAIM_OUTSIDE_TRANSACTION',
      );
    }
    if (claims.length === 0) return;
    this.validateClaims(claims);

    const tenantId = this.tenantPrisma.getTenantId();
    const prisma = this.tenantPrisma.getClient();
    const ordered = [...claims].sort((a, b) => {
      if (a.promotionId === b.promotionId) return 0;
      return a.promotionId < b.promotionId ? -1 : 1;
    });

    for (const { promotionId, units } of ordered) {
      // Ledger-first gate: only the tx that inserts the unique row increments.
      const inserted = await prisma.promotionUsage.createMany({
        data: [{ tenantId, saleId, promotionId, units }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        await this.assertIdempotentRetry(
          saleId,
          tenantId,
          promotionId,
          units,
          prisma,
        );
        continue;
      }
      const updated = await prisma.$queryRaw<
        Array<{ consumedProductUnits: number; maxProductUnits: number | null }>
      >(Prisma.sql`
        UPDATE "promotions"
           SET "consumedProductUnits" = "consumedProductUnits" + ${units}, "updatedAt" = NOW()
         WHERE "id" = ${promotionId}
           AND "tenantId" = ${tenantId}
           AND "consumedProductUnits" <= ${PG_INT_MAX} - ${units}
           AND (
                 "maxProductUnits" IS NULL
                 OR "consumedProductUnits" <= "maxProductUnits" - ${units}
               )
         RETURNING "consumedProductUnits", "maxProductUnits"
      `);
      if (updated.length !== 1) {
        throw new BusinessRuleViolationError(
          'Promotion capacity exceeded',
          'PROMOTION_CAPACITY_EXCEEDED',
          { saleId, promotionId, units },
        );
      }
      await this.publishNearCapacityIfCrossed(
        saleId,
        tenantId,
        promotionId,
        units,
        updated[0],
        prisma,
      );
    }
  }

  /**
   * Emits `promotion.near_capacity.detected` only when the finite-cap counter
   * crosses upward through 80%: strictly below before the increment and at or
   * above it after (`previous*5 < max*4 && new*5 >= max*4`). The post-increment
   * row comes from `UPDATE ... RETURNING`, so there is no second read, no
   * rounding, and no float comparison. A publish failure propagates so the
   * ambient transaction rolls back the ledger, counter, and outbox together.
   */
  private async publishNearCapacityIfCrossed(
    saleId: string,
    tenantId: string,
    promotionId: string,
    units: number,
    row: { consumedProductUnits: number; maxProductUnits: number | null },
    tx: ReturnType<TenantPrismaService['getClient']>,
  ): Promise<void> {
    const { consumedProductUnits: newConsumed, maxProductUnits: max } = row;
    if (max === null) return;

    const previousConsumed = newConsumed - units;
    if (!(previousConsumed * 5 < max * 4 && newConsumed * 5 >= max * 4)) return;

    await this.outboxWriter.publish(
      tx,
      tenantId,
      'Promotion',
      promotionId,
      'promotion.near_capacity.detected',
      {
        tenantId,
        promotionId,
        saleId,
        previousConsumedProductUnits: previousConsumed,
        consumedProductUnits: newConsumed,
        maxProductUnits: max,
        occurredAt: new Date().toISOString(),
      },
    );
  }

  async restoreForSale(saleId: string): Promise<void> {
    if (!this.tenantPrisma.isInTransaction()) {
      throw new BusinessRuleViolationError(
        'Promotion capacity restore requires an active ambient transaction',
        'PROMOTION_CAPACITY_RESTORE_OUTSIDE_TRANSACTION',
      );
    }
    if (saleId.length === 0) {
      throw new InvalidArgumentError(
        'Promotion capacity restore requires a non-empty saleId',
        'PROMOTION_CAPACITY_RESTORE_INVALID',
      );
    }

    const tenantId = this.tenantPrisma.getTenantId();
    const prisma = this.tenantPrisma.getClient();
    // Locale-independent ordering is delegated to the database so the
    // stamp/decrement sequence is deterministic across environments.
    const activeRows = await prisma.promotionUsage.findMany({
      where: { tenantId, saleId, restoredAt: null },
      select: { promotionId: true, units: true },
      orderBy: { promotionId: 'asc' },
    });

    for (const { promotionId, units } of activeRows) {
      // Stamp-first gate: only the retry that flips `restoredAt` decrements.
      const stamped = await prisma.$executeRaw(Prisma.sql`
        UPDATE "promotion_usages"
           SET "restoredAt" = NOW()
         WHERE "tenantId" = ${tenantId}
           AND "saleId" = ${saleId}
           AND "promotionId" = ${promotionId}
           AND "restoredAt" IS NULL
      `);
      if (stamped === 0) continue;

      // Guarded decrement: a counter below the ledger units means the ledger
      // and the counter diverged, so the whole ambient transaction must fail.
      const decremented = await prisma.$executeRaw(Prisma.sql`
        UPDATE "promotions"
           SET "consumedProductUnits" = "consumedProductUnits" - ${units}, "updatedAt" = NOW()
         WHERE "id" = ${promotionId}
           AND "tenantId" = ${tenantId}
           AND "consumedProductUnits" >= ${units}
      `);
      if (decremented !== 1) {
        throw new BusinessRuleViolationError(
          'Promotion counter is smaller than the restored ledger units',
          'PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH',
          { saleId, promotionId, units },
        );
      }
    }
  }

  private async assertIdempotentRetry(
    saleId: string,
    tenantId: string,
    promotionId: string,
    units: number,
    prisma: ReturnType<TenantPrismaService['getClient']>,
  ): Promise<void> {
    const existing = await prisma.promotionUsage.findUnique({
      where: {
        tenantId_saleId_promotionId: { tenantId, saleId, promotionId },
      },
    });
    if (existing?.restoredAt === null && existing.units === units) return;
    throw new BusinessRuleViolationError(
      'Promotion capacity claim does not match the existing ledger row',
      'PROMOTION_CAPACITY_CLAIM_MISMATCH',
      { saleId, promotionId, units },
    );
  }

  private validateClaims(claims: PromotionCapacityClaim[]): void {
    const seen = new Set<string>();
    for (const claim of claims) {
      const validId =
        typeof claim.promotionId === 'string' && claim.promotionId.length > 0;
      const validUnits =
        Number.isSafeInteger(claim.units) &&
        claim.units > 0 &&
        claim.units <= PG_INT_MAX;
      if (!validId || !validUnits) {
        throw new InvalidArgumentError(
          'Promotion capacity claims require a non-empty promotionId and positive PostgreSQL INTEGER units',
          'PROMOTION_CAPACITY_CLAIM_INVALID',
        );
      }
      if (seen.has(claim.promotionId)) {
        throw new InvalidArgumentError(
          'Promotion capacity claim contains a duplicate promotionId',
          'PROMOTION_CAPACITY_CLAIM_DUPLICATE',
        );
      }
      seen.add(claim.promotionId);
    }
  }
}
