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
  QuotationAlreadyConvertedError,
  QuotationNotDraftError,
} from '../domain/quotation.errors';
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
import type { QuotationIvaRateClassification } from '../domain/quotation-tax.types';

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

  /**
   * quotation-sale-conversion / T1 — tenant-qualified `FOR UPDATE` lock on
   * the root row, returning the COMMITTED lifecycle facts the write guards
   * need. Same lock the conversion takes, so a draft write and a conversion
   * of the same quotation are strictly serialized. Must run inside a
   * transaction (the lock lives until commit / rollback).
   */
  private async lockRoot(
    id: string,
    tenantId: string,
  ): Promise<{
    status: QuotationStatus;
    convertedSaleId: string | null;
  } | null> {
    const rows = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ status: QuotationStatus; convertedSaleId: string | null }>
    >`
      SELECT status::text AS status, "convertedSaleId"
      FROM quotations
      WHERE id = ${id} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  // ============================================================
  // save — ONE transaction: lock the root, guard, write the root, replace
  // items + junctions. Joins an ambient transaction when present.
  // ============================================================
  async save(quotation: Quotation): Promise<Quotation> {
    // quotation-sale-conversion / T1 (verifier M2) — atomic. The root row
    // lock is held from the first statement until commit, and the
    // conversion takes the same lock before reading the quotation, so a
    // concurrent conversion sees either the full old or the full new
    // quotation (items, vetoes, opt-ins included), never a mix. A save that
    // loses the race to a conversion is rejected before ANY write.
    return this.tenantPrisma.runInTransaction(() => this.saveLocked(quotation));
  }

  private async saveLocked(quotation: Quotation): Promise<Quotation> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    const rootData = {
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
      // quotation-sale-conversion / T1 — the link is owned by the
      // conversion CAS; `save` only round-trips the loaded value.
      convertedSaleId: quotation.convertedSaleId,
      convertedAt: quotation.convertedAt,
    };

    const existing = await this.lockRoot(quotation.id, tenantId);
    // A row that already became a live sale is read-only for every
    // aggregate that is not itself the converted one (stale DRAFT read →
    // conversion → late save). Rejected under the lock, before any write.
    if (
      existing &&
      existing.status === 'CONVERTED_TO_SALE' &&
      existing.convertedSaleId !== null &&
      quotation.status !== 'CONVERTED_TO_SALE'
    ) {
      throw new QuotationNotDraftError('CONVERTED_TO_SALE');
    }

    if (!existing) {
      // `tenantId` rides along explicitly so a row can never land in the
      // wrong tenant (the FK to Tenant rejects a bogus id).
      await prisma.quotation.create({
        data: {
          id: quotation.id,
          tenantId,
          ...rootData,
        } as Prisma.QuotationUncheckedCreateInput,
      });
    } else {
      // quotation-sale-conversion / T1 — the root write is a compare-and-
      // set: an aggregate that is NOT converted can never overwrite a row
      // that already became a live sale (stale DRAFT read → concurrent
      // conversion → late save). Under READ COMMITTED the UPDATE re-checks
      // the WHERE after waiting on the conversion's row lock, and it runs
      // BEFORE any item / junction write, so a rejected save leaves the
      // converted row untouched.
      const updated = await prisma.quotation.updateMany({
        where: {
          id: quotation.id,
          tenantId,
          ...(quotation.status === 'CONVERTED_TO_SALE'
            ? {}
            : {
                OR: [
                  { status: { not: 'CONVERTED_TO_SALE' } },
                  { convertedSaleId: null },
                ],
              }),
        },
        data: { ...rootData, updatedAt: new Date() },
      });
      if (updated.count !== 1) {
        throw new QuotationNotDraftError('CONVERTED_TO_SALE');
      }
    }

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
          // WU1 — round-trip the parent-product IVA snapshot verbatim.
          // Nulls stay nulls: historic (pre-migration) rows must never
          // gain a fabricated snapshot.
          taxableBaseCents: item.taxableBaseCents,
          ivaRateClassification: item.ivaRateClassification,
          chargeProductTaxesSnapshot: item.chargeProductTaxesSnapshot,
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
    const { page, limit, sortBy = 'createdAt', sortOrder = 'desc' } = query;

    const skip = (page - 1) * limit;
    const where = this.buildWhere(query);

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

  /**
   * Compose the `where` clause for findAll. Each filter is a single
   * clause; multiple clauses are AND-ed (mirrors the Sale repository's
   * `buildExtendedWhere`). A single clause is returned directly so the
   * generated SQL stays flat when there is only one filter.
   *
   * Semantics: OR inside each multi-value group (`status`, `customerId`,
   * `search` first/last name), AND between groups. `expiresAt`/`totalCents`
   * ranges use `!== undefined` checks so a `0` bound (e.g. minTotalCents=0)
   * is honored.
   */
  private buildWhere(query: QuotationFindAllQuery): Prisma.QuotationWhereInput {
    const andClauses: Prisma.QuotationWhereInput[] = [];

    if (query.status?.length) {
      andClauses.push({ status: { in: query.status } });
    }

    if (query.customerId?.length) {
      andClauses.push({ customerId: { in: query.customerId } });
    }

    const search = query.search?.trim();
    if (search) {
      andClauses.push({
        OR: [
          {
            customer: { firstName: { contains: search, mode: 'insensitive' } },
          },
          { customer: { lastName: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }

    if (query.createdFrom || query.createdTo) {
      const createdRange: Prisma.DateTimeFilter = {};
      if (query.createdFrom) {
        createdRange.gte = query.createdFrom;
      }
      if (query.createdTo) {
        createdRange.lte = query.createdTo;
      }
      andClauses.push({ createdAt: createdRange });
    }

    if (query.expiresFrom !== undefined || query.expiresTo !== undefined) {
      andClauses.push({
        expiresAt: {
          ...(query.expiresFrom !== undefined
            ? { gte: query.expiresFrom }
            : {}),
          ...(query.expiresTo !== undefined ? { lte: query.expiresTo } : {}),
        },
      });
    }

    if (
      query.minTotalCents !== undefined ||
      query.maxTotalCents !== undefined
    ) {
      andClauses.push({
        totalCents: {
          ...(query.minTotalCents !== undefined
            ? { gte: query.minTotalCents }
            : {}),
          ...(query.maxTotalCents !== undefined
            ? { lte: query.maxTotalCents }
            : {}),
        },
      });
    }

    return andClauses.length === 1 ? andClauses[0] : { AND: andClauses };
  }

  // ============================================================
  // delete — hard delete with cascade
  // ============================================================
  async delete(id: string): Promise<void> {
    // quotation-sale-conversion / T1 (verifier M1) — the status rule is
    // enforced HERE, under the row lock, not only on the caller's earlier
    // unlocked read: a conversion (or send) that committed in between makes
    // the delete fail with the matching error and delete nothing.
    return this.tenantPrisma.runInTransaction(async () => {
      const prisma = this.tenantPrisma.getClient();
      const tenantId = this.requireTenantId();
      const row = await this.lockRoot(id, tenantId);
      // Idempotent: a missing (or cross-tenant) id does NOT throw.
      if (!row) return;
      if (row.status === 'CONVERTED_TO_SALE') {
        throw new QuotationAlreadyConvertedError(id, row.convertedSaleId);
      }
      if (row.status !== 'DRAFT' && row.status !== 'CANCELLED') {
        throw new BusinessRuleViolationError(
          `Quotation is in ${row.status} status; only DRAFT and CANCELLED can be deleted`,
          'QUOTATION_CANNOT_DELETE',
        );
      }
      // Belt and braces: the DELETE itself repeats the status condition.
      await prisma.quotation.deleteMany({
        where: { id, tenantId, status: { in: ['DRAFT', 'CANCELLED'] } },
      });
    });
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
      convertedSaleId: data.convertedSaleId,
      convertedAt: data.convertedAt,
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
        discountType: item.discountType as 'amount' | 'percentage' | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents ?? 0,
        promotionId: item.promotionId,
        // WU1 — map the persisted IVA snapshot verbatim. Prisma
        // `IvaRate | null` → domain rate union, nulls preserved
        // exactly (historic rows stay incomplete by design).
        taxableBaseCents: item.taxableBaseCents,
        ivaRateClassification:
          item.ivaRateClassification as QuotationIvaRateClassification | null,
        chargeProductTaxesSnapshot: item.chargeProductTaxesSnapshot,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      vetoedPromotionIds: data.promotionVetoes.map((v) => v.promotionId),
      optedInManualPromotionIds: data.promotionOptIns.map((o) => o.promotionId),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
