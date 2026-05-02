import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { Promotion } from '../domain/promotion.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type {
  IPromotionRepository,
  PromotionFindAllQuery,
  PromotionFindAllResult,
} from '../domain/promotion.repository';
import { Prisma } from '@prisma/client';

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
          } as Prisma.PromotionUncheckedCreateInput,
          update: {
            title: promotion.title,
            method: promotion.method,
            status: promotion.status,
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
  // updateStatus — patch status + optional endDate
  // ============================================================
  async updateStatus(
    id: string,
    status: 'ENDED' | 'ACTIVE' | 'SCHEDULED',
    endDate?: Date | null,
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.promotion.update({
      where: { id },
      data: {
        status,
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
