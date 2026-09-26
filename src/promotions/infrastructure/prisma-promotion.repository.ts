import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { Promotion } from '../domain/promotion.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type {
  ActiveAutomaticPromotionSnapshot,
  IPromotionRepository,
  PromotionFindAllQuery,
  PromotionFindAllResult,
} from '../domain/promotion.repository';
import { Prisma } from '@prisma/client';

/**
 * Owner-approved ceiling on ACTIVE AUTOMATIC promotions per bot quote.
 *
 * A tenant above this cap cannot be snapshotted within the agreed cost
 * budget, so the read stays bounded and reports itself as incomplete instead
 * of paginating (offset paging can miss a row under a concurrent
 * delete+insert that keeps the total unchanged). The bot quote then fails
 * closed. Overload is an explicit owner decision, not an accident.
 */
export const ACTIVE_AUTOMATIC_PROMOTION_CAP = 1000;

// Full include shape used for findById and save return
const PROMOTION_INCLUDE = {
  targetItems: true,
  customers: {
    include: {
      customer: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  priceLists: {
    include: {
      globalPriceList: { select: { id: true, name: true } },
    },
  },
  daysOfWeek: true,
} satisfies Prisma.PromotionInclude;

type PromotionWithRelations = Prisma.PromotionGetPayload<{
  include: typeof PROMOTION_INCLUDE;
}>;

@Injectable()
export class PrismaPromotionRepository implements IPromotionRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // ============================================================
  // save — upsert promotion + replace all join rows atomically
  // ============================================================
  async save(promotion: Promotion): Promise<Promotion> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    try {
      const saved = await prisma.$transaction(async (tx) => {
        // Upsert the main promotion row
        await tx.promotion.upsert({
          where: { id: promotion.id },
          create: {
            id: promotion.id,
            title: promotion.title,
            type: promotion.type,
            method: promotion.method,
            status: promotion.status,
            manuallyEnded: promotion.manuallyEnded,
            startDate: promotion.startDate,
            endDate: promotion.endDate,
            customerScope: promotion.customerScope,
            discountType: promotion.discountType,
            discountValue: promotion.discountValue,
            minPurchaseAmountCents: promotion.minPurchaseAmountCents,
            appliesTo: promotion.appliesTo,
            buyQuantity: promotion.buyQuantity,
            getQuantity: promotion.getQuantity,
            getDiscountPercent: promotion.getDiscountPercent,
            buyTargetType: promotion.buyTargetType,
            getTargetType: promotion.getTargetType,
            // Persist the entity counter (new entities carry 0) so a
            // hydrated nonzero entity cannot fall back to a DB-default reset.
            maxProductUnits: promotion.maxProductUnits,
            consumedProductUnits: promotion.consumedProductUnits,
            tenantId,
          } as Prisma.PromotionUncheckedCreateInput,
          update: {
            title: promotion.title,
            method: promotion.method,
            status: promotion.status,
            manuallyEnded: promotion.manuallyEnded,
            startDate: promotion.startDate,
            endDate: promotion.endDate,
            customerScope: promotion.customerScope,
            discountType: promotion.discountType,
            discountValue: promotion.discountValue,
            minPurchaseAmountCents: promotion.minPurchaseAmountCents,
            appliesTo: promotion.appliesTo,
            buyQuantity: promotion.buyQuantity,
            getQuantity: promotion.getQuantity,
            getDiscountPercent: promotion.getDiscountPercent,
            buyTargetType: promotion.buyTargetType,
            getTargetType: promotion.getTargetType,
            updatedAt: new Date(),
          },
        });

        // Re-cap after the upsert (same tx) against the LIVE counter.
        const recapped = await tx.promotion.updateMany({
          where: {
            id: promotion.id,
            ...(promotion.maxProductUnits === null
              ? {}
              : {
                  consumedProductUnits: { lte: promotion.maxProductUnits },
                }),
          },
          data: { maxProductUnits: promotion.maxProductUnits },
        });

        if (recapped.count !== 1) {
          throw new InvalidArgumentError(
            'consumedProductUnits cannot exceed maxProductUnits',
            'PRODUCT_UNIT_CAPACITY_EXCEEDED',
          );
        }

        // Delete-then-create all join tables (deterministic replace)
        await tx.promotionTargetItem.deleteMany({
          where: { promotionId: promotion.id },
        });
        if (promotion.targetItems.length > 0) {
          await tx.promotionTargetItem.createMany({
            data: promotion.targetItems.map((item) => ({
              promotionId: promotion.id,
              side: item.side,
              targetType: item.targetType,
              targetId: item.targetId,
              tenantId,
            })) as Prisma.PromotionTargetItemCreateManyInput[],
          });
        }

        await tx.promotionCustomer.deleteMany({
          where: { promotionId: promotion.id },
        });
        if (promotion.customers.length > 0) {
          await tx.promotionCustomer.createMany({
            data: promotion.customers.map((c) => ({
              promotionId: promotion.id,
              customerId: c.customerId,
              tenantId,
            })) as Prisma.PromotionCustomerCreateManyInput[],
          });
        }

        await tx.promotionPriceList.deleteMany({
          where: { promotionId: promotion.id },
        });
        if (promotion.priceLists.length > 0) {
          await tx.promotionPriceList.createMany({
            data: promotion.priceLists.map((pl) => ({
              promotionId: promotion.id,
              globalPriceListId: pl.globalPriceListId,
              tenantId,
            })) as Prisma.PromotionPriceListCreateManyInput[],
          });
        }

        await tx.promotionDayOfWeek.deleteMany({
          where: { promotionId: promotion.id },
        });
        if (promotion.daysOfWeek.length > 0) {
          await tx.promotionDayOfWeek.createMany({
            data: promotion.daysOfWeek.map((d) => ({
              promotionId: promotion.id,
              day: d.day,
              tenantId,
            })) as Prisma.PromotionDayOfWeekCreateManyInput[],
          });
        }

        // Fetch the fully-populated row to return
        return tx.promotion.findUniqueOrThrow({
          where: { id: promotion.id },
          include: PROMOTION_INCLUDE,
        });
      });

      return this.toDomain(saved);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta?.target.includes('promotionId') &&
        error.meta?.target.includes('targetId')
      ) {
        throw new InvalidArgumentError(
          'Duplicate target mapping for promotion',
          'duplicate_target',
        );
      }
      throw error;
    }
  }

  // ============================================================
  // findById — full include
  // ============================================================
  async findById(id: string): Promise<Promotion | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.promotion.findUnique({
      where: { id },
      include: PROMOTION_INCLUDE,
    });
    return data ? this.toDomain(data) : null;
  }

  // ============================================================
  // findActiveAutomaticSnapshot — bounded whole-set read for the
  // bot quote path.
  //
  // One `id`-ordered `findMany` with `take: cap + 1` inside a
  // RepeatableRead interactive transaction. No `skip`, no separate
  // `count`: paging can silently miss a row when a concurrent
  // delete+insert leaves the total unchanged, and the `count` in
  // `findAll` races the row read. The sentinel row (cap + 1) is the
  // overload probe — when it appears, the set is larger than the cap
  // and the snapshot is reported incomplete so callers fail closed.
  //
  // Tenant scoping comes from the tenant-extended client resolved
  // through `getClient()` (same contract as the rest of this adapter).
  // ============================================================
  async findActiveAutomaticSnapshot(): Promise<ActiveAutomaticPromotionSnapshot> {
    const now = new Date();

    const rows = await this.tenantPrisma.runInTransaction(() => {
      const prisma = this.tenantPrisma.getClient();
      return prisma.promotion.findMany({
        // Match Promotion.getEffectiveStatus(now): a manual closure is the
        // only permanent override. Persisted status can be stale after a date
        // change, so filtering status='ENDED' could hide an active restriction.
        where: {
          method: 'AUTOMATIC',
          manuallyEnded: false,
          AND: [
            { OR: [{ startDate: null }, { startDate: { lte: now } }] },
            { OR: [{ endDate: null }, { endDate: { gte: now } }] },
          ],
        },
        orderBy: { id: 'asc' },
        take: ACTIVE_AUTOMATIC_PROMOTION_CAP + 1,
        include: PROMOTION_INCLUDE,
      });
    }, Prisma.TransactionIsolationLevel.RepeatableRead);

    return {
      promotions: rows
        .slice(0, ACTIVE_AUTOMATIC_PROMOTION_CAP)
        .map((row) => this.toDomain(row)),
      complete: rows.length <= ACTIVE_AUTOMATIC_PROMOTION_CAP,
    };
  }

  // ============================================================
  // findAll — dynamic where + pagination
  // ============================================================
  async findAll(query: PromotionFindAllQuery): Promise<PromotionFindAllResult> {
    const prisma = this.tenantPrisma.getClient();
    const {
      page,
      limit,
      type,
      status,
      method,
      customerScope,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const skip = (page - 1) * limit;

    // Build base where clause (without status — status is lazy)
    const where: Prisma.PromotionWhereInput = {};

    if (type) {
      where.type = type as Prisma.EnumPromotionTypeFilter;
    }
    if (method) {
      where.method = method as Prisma.EnumPromotionMethodFilter;
    }
    if (customerScope) {
      where.customerScope = customerScope as Prisma.EnumCustomerScopeFilter;
    }
    if (search) {
      where.title = { contains: search, mode: 'insensitive' };
    }

    // Status filter — translate to date-range aware conditions
    if (status) {
      const now = new Date();
      switch (status) {
        case 'ENDED':
          where.OR = [{ status: 'ENDED' }, { endDate: { lt: now } }];
          break;
        case 'SCHEDULED':
          where.AND = [
            { startDate: { gt: now } },
            { status: { not: 'ENDED' } },
          ];
          break;
        case 'ACTIVE':
          where.AND = [
            { status: { not: 'ENDED' } },
            {
              OR: [{ startDate: null }, { startDate: { lte: now } }],
            },
            {
              OR: [{ endDate: null }, { endDate: { gte: now } }],
            },
          ];
          break;
      }
    }

    const [rows, total] = await Promise.all([
      prisma.promotion.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: PROMOTION_INCLUDE,
      }),
      prisma.promotion.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toDomain(r)),
      total,
    };
  }

  // ============================================================
  // delete — hard delete (cascade handles join tables)
  // ============================================================
  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.promotion.delete({ where: { id } });
  }

  // ============================================================
  // deleteMany — batch hard delete (cascade handles join tables)
  //
  // Returns the count of actually-deleted rows so the orchestrator
  // can echo `{ deleted: N }` to the caller. Joins (targetItems,
  // customers, priceLists, daysOfWeek) cascade via Prisma schema.
  // `tenantPrisma.getClient()` honours the ambient CLS tx so the
  // entire batch is atomic — a single FK violation rolls back
  // every row.
  // ============================================================
  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const prisma = this.tenantPrisma.getClient();
    const result = await prisma.promotion.deleteMany({
      where: { id: { in: ids } },
    });
    return result.count;
  }

  // ============================================================
  // updateStatus — patch status + optional endDate
  // ============================================================
  async updateStatus(
    id: string,
    status: 'ENDED' | 'ACTIVE' | 'SCHEDULED',
    endDate?: Date | null,
    manuallyEnded?: boolean,
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.promotion.update({
      where: { id },
      data: {
        status,
        // Persist the manual override whenever we are told the promotion
        // is ENDED via the application layer (i.e. `endPromotion`).
        // For ACTIVE/SCHEDULED writes we leave the flag untouched to
        // preserve operator intent across status flips that originated
        // outside of `Promotion.end()`.
        manuallyEnded: manuallyEnded ?? status === 'ENDED',
        ...(endDate !== undefined ? { endDate } : {}),
        updatedAt: new Date(),
      },
    });
  }

  // ============================================================
  // toDomain — map Prisma row to domain entity
  // ============================================================
  private toDomain(data: PromotionWithRelations): Promotion {
    return Promotion.fromPersistence({
      id: data.id,
      title: data.title,
      type: data.type,
      method: data.method,
      status: data.status,
      // `data.manuallyEnded` is a non-null boolean column (default false).
      // The `?? false` guard keeps the mapper safe even if Prisma's typed
      // shape ever changes (e.g. selects without the column).
      manuallyEnded: data.manuallyEnded ?? false,
      startDate: data.startDate,
      endDate: data.endDate,
      customerScope: data.customerScope,
      discountType: data.discountType,
      discountValue: data.discountValue,
      minPurchaseAmountCents: data.minPurchaseAmountCents,
      appliesTo: data.appliesTo,
      buyQuantity: data.buyQuantity,
      getQuantity: data.getQuantity,
      getDiscountPercent: data.getDiscountPercent,
      buyTargetType: data.buyTargetType,
      getTargetType: data.getTargetType,
      // Map both capacity columns. Hydration is lenient inside
      // `fromPersistence`, so a legacy/corrupt row stays readable.
      maxProductUnits: data.maxProductUnits,
      consumedProductUnits: data.consumedProductUnits,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      targetItems: (data.targetItems ?? []).map((ti) => ({
        id: ti.id,
        side: ti.side,
        targetType: ti.targetType,
        targetId: ti.targetId,
      })),
      customers: (data.customers ?? []).map((c) => ({
        id: c.id,
        customerId: c.customerId,
        customer: c.customer ?? null,
      })),
      priceLists: (data.priceLists ?? []).map((pl) => ({
        id: pl.id,
        globalPriceListId: pl.globalPriceListId,
        globalPriceList: pl.globalPriceList ?? null,
      })),
      daysOfWeek: (data.daysOfWeek ?? []).map((d) => ({
        id: d.id,
        day: d.day,
      })),
    });
  }
}
