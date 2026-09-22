/**
 * ADAPTER: PrismaPromotionUsageRepository — ambient-tx-only capacity ledger.
 * `getClient()` is non-transactional without an active tx, so entry is guarded;
 * every statement carries `tenantId` explicitly for raw/unextended clients.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
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
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

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
      const updated = await prisma.$executeRaw(Prisma.sql`
        UPDATE "promotions"
           SET "consumedProductUnits" = "consumedProductUnits" + ${units}, "updatedAt" = NOW()
         WHERE "id" = ${promotionId}
           AND "tenantId" = ${tenantId}
           AND "consumedProductUnits" <= ${PG_INT_MAX} - ${units}
           AND (
                 "maxProductUnits" IS NULL
                 OR "consumedProductUnits" <= "maxProductUnits" - ${units}
               )
      `);
      if (updated !== 1) {
        throw new BusinessRuleViolationError(
          'Promotion capacity exceeded',
          'PROMOTION_CAPACITY_EXCEEDED',
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
