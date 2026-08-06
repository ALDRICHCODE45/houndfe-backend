/**
 * PrismaQuotationRepository — Infrastructure adapter for IQuotationRepository.
 *
 * Mirrors the PrismaSaleRepository's upsert pattern: write the root row
 * via `upsert`, delete-then-createMany for the items + promotion junction
 * rows so the in-memory aggregate is the single source of truth. Reload
 * via `findById` after write so the returned entity carries the canonical
 * DB-side `createdAt` / `updatedAt` timestamps.
 *
 * All reads/writes are scoped to the current tenant via
 * `TenantPrismaService`. Cross-tenant access returns `null` / empty arrays
 * (HTTP layer translates to 404).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  Quotation,
  type QuotationCancelReason,
  type QuotationStatus,
} from '../domain/quotation.entity';
import type {
  IQuotationRepository,
  QuotationFindAllQuery,
  QuotationFindAllResult,
} from '../domain/quotation.repository';

const QUOTATION_INCLUDE = {
  items: true,
  promotionVetoes: { select: { promotionId: true } },
  promotionOptIns: { select: { promotionId: true } },
} satisfies Prisma.QuotationInclude;

type QuotationWithRelations = Prisma.QuotationGetPayload<{
  include: typeof QUOTATION_INCLUDE;
}>;

@Injectable()
export class PrismaQuotationRepository implements IQuotationRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireTenantId(): string {
    const tenantId = this.tenantPrisma.getTenantId();
    if (!tenantId) {
      throw new BusinessRuleViolationError(
        'TENANT_CONTEXT_REQUIRED',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }

  // ============================================================
  // save — upsert root + replace items + promotion junctions
  // ============================================================
  async save(quotation: Quotation): Promise<Quotation> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    // Upsert the root row. `tenantId` rides along on every branch — even
    // for the update path — so a corrupted row that landed in the wrong
    // tenant cannot survive the round-trip (the FK to Tenant rejects it).
    await prisma.quotation.upsert({
      where: { id: quotation.id },
      create: {
        id: quotation.id,
        sellerUserId: quotation.sellerUserId,
        tenantId,
        customerId: quotation.customerId,
        globalPriceListId: quotation.globalPriceListId,
        priceListExplicitlySet: quotation.priceListExplicitlySet,
        status: quotation.status,
        expiresAt: quotation.expiresAt,
        cancelReason: quotation.cancelReason,
        canceledAt: quotation.canceledAt,
        subtotalCents: quotation.subtotalCents,
        discountCents: quotation.discountCents,
        totalCents: quotation.totalCents,
        manuallyEnded: quotation.manuallyEnded,
        customerNotes: quotation.customerNotes,
        taxRate: quotation.taxRate,
      } as Prisma.QuotationUncheckedCreateInput,
      update: {
        sellerUserId: quotation.sellerUserId,
        customerId: quotation.customerId,
        globalPriceListId: quotation.globalPriceListId,
        priceListExplicitlySet: quotation.priceListExplicitlySet,
        status: quotation.status,
        expiresAt: quotation.expiresAt,
        cancelReason: quotation.cancelReason,
        canceledAt: quotation.canceledAt,
        subtotalCents: quotation.subtotalCents,
        discountCents: quotation.discountCents,
        totalCents: quotation.totalCents,
        manuallyEnded: quotation.manuallyEnded,
        customerNotes: quotation.customerNotes,
        taxRate: quotation.taxRate,
        updatedAt: new Date(),
      },
    });

    // Delete-then-createMany for items (mirrors PrismaSaleRepository).
    if (quotation.items.length > 0) {
      await prisma.quotationItem.deleteMany({
        where: { quotationId: quotation.id },
      });
      await prisma.quotationItem.createMany({
        data: quotation.items.map((item) => ({
          id: item.id,
          quotationId: quotation.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: item.unitPriceCurrency,
          priceSource: item.priceSource,
          appliedPriceListId: item.appliedPriceListId,
          customPriceCents: item.customPriceCents,
          discountType: item.discountType,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          promotionId: item.promotionId,
          tenantId,
        })) as Prisma.QuotationItemCreateManyInput[],
      });
    } else {
      // Explicit empty clear — the entity's clearItems() path lands here.
      await prisma.quotationItem.deleteMany({
        where: { quotationId: quotation.id },
      });
    }

    // Delete-then-createMany for veto rows (mirrors SalePromotionVeto).
    await prisma.quotationPromotionVeto.deleteMany({
      where: { quotationId: quotation.id, tenantId },
    });
    if (quotation.vetoedPromotionIds.length > 0) {
      await prisma.quotationPromotionVeto.createMany({
        data: quotation.vetoedPromotionIds.map((promotionId) => ({
          quotationId: quotation.id,
          promotionId,
          tenantId,
        })),
      });
    }

    // Delete-then-createMany for opt-in rows (mirrors SalePromotionOptIn).
    await prisma.quotationPromotionOptIn.deleteMany({
      where: { quotationId: quotation.id, tenantId },
    });
    if (quotation.optedInManualPromotionIds.length > 0) {
      await prisma.quotationPromotionOptIn.createMany({
        data: quotation.optedInManualPromotionIds.map((promotionId) => ({
          quotationId: quotation.id,
          promotionId,
          tenantId,
        })),
      });
    }

    // Reload via findById so the returned entity carries the canonical
    // DB-side timestamps (createdAt / updatedAt) and any default values
    // that Postgres generated on insert.
    return (await this.findById(quotation.id))!;
  }

  // ============================================================
  // findById — full include, tenant-scoped
  // ============================================================
  async findById(id: string): Promise<Quotation | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    const data = await prisma.quotation.findFirst({
      where: { id, tenantId },
      include: QUOTATION_INCLUDE,
    });

    if (!data) return null;
    return this.toDomain(data);
  }

  // ============================================================
  // findAll — pagination + filters, tenant-scoped
  // ============================================================
  async findAll(query: QuotationFindAllQuery): Promise<QuotationFindAllResult> {
    const prisma = this.tenantPrisma.getClient();
    const {
      page,
      limit,
      status,
      customerId,
      createdFrom,
      createdTo,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const skip = (page - 1) * limit;

    const where: Prisma.QuotationWhereInput = {};
    if (status) {
      where.status = status as Prisma.EnumQuotationStatusFilter;
    }
    if (customerId) {
      where.customerId = customerId;
    }
    if (createdFrom || createdTo) {
      where.createdAt = {};
      if (createdFrom) {
        where.createdAt.gte = createdFrom;
      }
      if (createdTo) {
        where.createdAt.lte = createdTo;
      }
    }

    const [rows, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: QUOTATION_INCLUDE,
      }),
      prisma.quotation.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.toDomain(r)),
      total,
    };
  }

  // ============================================================
  // delete — hard delete with cascade
  // ============================================================
  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    // Idempotent: a missing id does NOT throw. This keeps callers free
    // of the P2025 race window when two concurrent deletes hit the same
    // id. Tenant-scoped filter ensures cross-tenant deletes 404 silently.
    await prisma.quotation.deleteMany({ where: { id, tenantId } });
  }

  // ============================================================
  // Mapper — Prisma row → domain entity
  // ============================================================
  private toDomain(data: QuotationWithRelations): Quotation {
    return Quotation.fromPersistence({
      id: data.id,
      sellerUserId: data.sellerUserId,
      customerId: data.customerId,
      globalPriceListId: data.globalPriceListId,
      priceListExplicitlySet: data.priceListExplicitlySet,
      status: data.status as QuotationStatus,
      expiresAt: data.expiresAt,
      cancelReason: data.cancelReason as QuotationCancelReason | null,
      canceledAt: data.canceledAt,
      subtotalCents: data.subtotalCents,
      discountCents: data.discountCents,
      totalCents: data.totalCents,
      manuallyEnded: data.manuallyEnded,
      customerNotes: data.customerNotes,
      taxRate: data.taxRate,
      items: data.items.map((item) => ({
        id: item.id,
        quotationId: item.quotationId,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        unitPriceCurrency: item.unitPriceCurrency,
        priceSource:
          (item.priceSource as 'PRICE_LIST' | 'CUSTOM' | null) ?? 'PRICE_LIST',
        appliedPriceListId: item.appliedPriceListId,
        customPriceCents: item.customPriceCents,
        discountType: item.discountType as
          | 'amount'
          | 'percentage'
          | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents ?? 0,
        promotionId: item.promotionId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      vetoedPromotionIds: data.promotionVetoes.map((v) => v.promotionId),
      optedInManualPromotionIds: data.promotionOptIns.map(
        (o) => o.promotionId,
      ),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
