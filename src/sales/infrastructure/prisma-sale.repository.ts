/**
 * PrismaSaleRepository - Infrastructure adapter for ISaleRepository.
 *
 * Implements persistence operations for Sales using Prisma ORM.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  DraftSaleResponse,
  ISaleRepository,
  PersistedChargePayment,
  PersistedSaleRefundRecord,
  PersistedSalePaymentRecord,
} from '../domain/sale.repository';
import {
  Sale,
  type SaleStatus,
  type AppliedOrderPromotionSnapshot,
} from '../domain/sale.entity';
import { SaleItem } from '../domain/sale-item.entity';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type {
  SalesListBaseFilter,
  SalesListExtendedFilter,
} from '../dto/sales-list-filter.types';

function extractLegacyReference(metadataJson: unknown): string | null {
  if (!metadataJson || typeof metadataJson !== 'object') {
    return null;
  }

  const candidate = (metadataJson as { reference?: unknown }).reference;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

@Injectable()
export class PrismaSaleRepository implements ISaleRepository {
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

  async save(sale: Sale): Promise<Sale> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    // Check if sale exists
    const existing = await prisma.sale.findUnique({
      where: { id: sale.id },
    });

    // Delete existing items (we'll recreate them from domain state)
    await prisma.saleItem.deleteMany({
      where: { saleId: sale.id },
    });

    // Create or update sale
    const saleData = {
      status: sale.status,
      channel: sale.channel,
      register: sale.register,
      deliveryStatus: sale.deliveryStatus,
      customerId: sale.customerId,
      shippingAddressId: sale.shippingAddressId,
      sellerUserId: sale.sellerUserId,
      dueDate: sale.dueDate,
      confirmedAt: sale.confirmedAt,
      folio: sale.folio,
    };

    if (!existing) {
      // Create new sale
      await prisma.sale.create({
        data: {
          id: sale.id,
          userId: sale.userId,
          tenantId,
          ...saleData,
        } as Prisma.SaleUncheckedCreateInput,
      });
    } else {
      // Update existing sale
      await prisma.sale.update({
        where: { id: sale.id },
        data: saleData,
      });
    }

    // Create items
    if (sale.items.length > 0) {
      await prisma.saleItem.createMany({
        data: sale.items.map((item) => ({
          id: item.id,
          saleId: sale.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: item.unitPriceCurrency,
          originalPriceCents: item.originalPriceCents,
          priceSource:
            item.priceSource === 'default'
              ? 'DEFAULT'
              : item.priceSource === 'price_list'
                ? 'PRICE_LIST'
                : 'CUSTOM',
          appliedPriceListId: item.appliedPriceListId,
          customPriceCents: item.customPriceCents,
          discountType: item.discountType,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          // WU3 — persist the exact BXGY reward percent from the entity.
          rewardDiscountPercent: item.rewardDiscountPercent,
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
          promotionId: item.promotionId,
          tenantId,
        })) as Prisma.SaleItemCreateManyInput[],
      });
    } else {
      // Explicitly handle empty items (for clearItems case)
      await prisma.saleItem.createMany({ data: [] });
    }

    // ---- Unit 3 — promotion persistence (veto + applied-order-promo) ----
    // Veto rows: delete-then-recreate for the sale to stay idempotent across
    // rapid mutations (and to handle both adds and removes in one pass).
    await prisma.salePromotionVeto.deleteMany({
      where: { saleId: sale.id, tenantId },
    });
    if (sale.vetoedPromotionIds.length > 0) {
      await prisma.salePromotionVeto.createMany({
        data: sale.vetoedPromotionIds.map((promotionId) => ({
          saleId: sale.id,
          promotionId,
          tenantId,
        })),
      });
    }

    // ---- Unit 6 close-out — MANUAL opt-in persistence ----
    // Mirrors the veto block EXACTLY (delete-then-createMany) so the
    // `optedInManualPromotionIds` set survives a save→findById reload.
    // Without this, every read mapper returns [] and a subsequent recompute
    // (e.g. from addItem) drops the manual line discount.
    await prisma.salePromotionOptIn.deleteMany({
      where: { saleId: sale.id, tenantId },
    });
    if (sale.optedInManualPromotionIds.length > 0) {
      await prisma.salePromotionOptIn.createMany({
        data: sale.optedInManualPromotionIds.map((promotionId) => ({
          saleId: sale.id,
          promotionId,
          tenantId,
        })),
      });
    }

    // Applied order promotion: upsert on (saleId) when set, delete when cleared.
    // The schema's `@@unique([saleId])` enforces one row per sale.
    if (sale.appliedOrderPromotion) {
      const snap = sale.appliedOrderPromotion;
      await prisma.salePromotionApplied.upsert({
        where: { saleId: sale.id },
        create: {
          saleId: sale.id,
          tenantId,
          promotionId: snap.promotionId,
          discountType: snap.discountType,
          discountValue: snap.discountValue,
          discountAmountCents: snap.discountAmountCents,
          discountTitle: snap.discountTitle,
        },
        update: {
          promotionId: snap.promotionId,
          discountType: snap.discountType,
          discountValue: snap.discountValue,
          discountAmountCents: snap.discountAmountCents,
          discountTitle: snap.discountTitle,
        },
      });
    } else {
      await prisma.salePromotionApplied.deleteMany({
        where: { saleId: sale.id, tenantId },
      });
    }

    // Reload and return
    return (await this.findById(sale.id))!;
  }

  async findById(id: string): Promise<Sale | null> {
    const prisma = this.tenantPrisma.getClient();
    // Explicit tenantId on the nested promotion-junction includes.
    // createTenantScopedPrisma only injects tenantId at the TOP-LEVEL
    // `where` / `data` and never recurses into nested `include` clauses
    // (see src/shared/prisma/tenant-prisma.factory.ts), and
    // SalePromotionOptIn / Veto / Applied are intentionally NOT in
    // TENANT_SCOPED_MODELS — so the include must filter EXPLICITLY to
    // match save's tenant-scoped deleteMany (mirrors the project
    // convention used by price-lists.service.ts for non-allowlisted
    // nested relations). Without this, a row from a different tenant
    // leaks into `optedInManualPromotionIds` and the engine auto-applies
    // a MANUAL promo with zero legitimate opt-in.
    const tenantId = this.requireTenantId();
    const saleData = await prisma.sale.findUnique({
      where: { id },
      include: {
        items: true,
        shippingAddress: { select: { id: true } },
        // Unit 3 — W2: load veto set + applied order-promo so the engine can
        // exclude vetoed promotions and the draft preview can show the order
        // discount. Item-level promotionId flows through `items: true`.
        promotionVetoes: {
          select: { promotionId: true },
          where: { tenantId },
        },
        // Unit 6 close-out: load MANUAL opt-in set so a reload preserves the
        // seller's opt-in across draft mutations (addItem, assignCustomer,
        // etc.). Without this, a recompute drops the manual line discount.
        promotionOptIns: {
          select: { promotionId: true },
          where: { tenantId },
        },
        appliedPromotion: { where: { tenantId } },
      },
    });

    if (!saleData) return null;

    const persistedSale = saleData as any;

    return Sale.fromPersistence({
      id: persistedSale.id,
      userId: persistedSale.userId,
      status: persistedSale.status as SaleStatus,
      channel: persistedSale.channel as 'POS' | 'ONLINE',
      register: persistedSale.register,
      deliveryStatus: persistedSale.deliveryStatus as
        | 'PENDING'
        | 'DELIVERED'
        | 'NOT_APPLICABLE',
      customerId: persistedSale.customerId,
      shippingAddressId: persistedSale.shippingAddressId,
      sellerUserId: persistedSale.sellerUserId,
      dueDate: persistedSale.dueDate,
      confirmedAt: persistedSale.confirmedAt,
      folio: persistedSale.folio,
      items: persistedSale.items.map((item) => ({
        id: item.id,
        saleId: item.saleId,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        unitPriceCurrency: item.unitPriceCurrency,
        originalPriceCents: item.originalPriceCents,
        priceSource: item.priceSource?.toLowerCase() as
          | 'default'
          | 'price_list'
          | 'custom'
          | undefined,
        appliedPriceListId: item.appliedPriceListId,
        customPriceCents: item.customPriceCents,
        discountType: item.discountType as 'amount' | 'percentage' | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents,
        // WU3 — round-trip the persisted BXGY reward percent on reload so a
        // subsequent re-save does not wipe it.
        rewardDiscountPercent: item.rewardDiscountPercent ?? null,
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
        promotionId: item.promotionId ?? null,
      })),
      createdAt: persistedSale.createdAt,
      updatedAt: persistedSale.updatedAt,
      appliedOrderPromotion: persistedSale.appliedPromotion
        ? {
            promotionId: persistedSale.appliedPromotion.promotionId ?? null,
            discountType:
              (persistedSale.appliedPromotion.discountType as
                | 'amount'
                | 'percentage'
                | null) ?? null,
            discountValue: persistedSale.appliedPromotion.discountValue ?? null,
            discountAmountCents:
              persistedSale.appliedPromotion.discountAmountCents,
            discountTitle: persistedSale.appliedPromotion.discountTitle ?? null,
          }
        : null,
      vetoedPromotionIds: (
        (persistedSale.promotionVetoes as Array<{ promotionId: string }>) ?? []
      ).map((v) => v.promotionId),
      optedInManualPromotionIds: (
        (persistedSale.promotionOptIns as Array<{ promotionId: string }>) ?? []
      ).map((o) => o.promotionId),
    });
  }

  async findDraftResponseById(id: string): Promise<DraftSaleResponse | null> {
    const prisma = this.tenantPrisma.getClient();
    // See findById above for why we pass `where: { tenantId }` on the
    // promotion-junction includes (createTenantScopedPrisma does NOT
    // recurse into nested includes; the convention is to filter
    // EXPLICITLY — same as price-lists.service.ts).
    const tenantId = this.requireTenantId();
    const saleData = await prisma.sale.findUnique({
      where: { id },
      include: {
        items: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        shippingAddress: {
          select: {
            id: true,
            street: true,
            exteriorNumber: true,
            interiorNumber: true,
            zipCode: true,
            neighborhood: true,
            municipality: true,
            city: true,
            state: true,
          },
        },
        // Unit 3 — W2: load veto + applied-promo for draft preview.
        promotionVetoes: {
          select: { promotionId: true },
          where: { tenantId },
        },
        // Unit 6 close-out: load MANUAL opt-in set so draft preview totals
        // and recompute paths see the seller's opt-in.
        promotionOptIns: {
          select: { promotionId: true },
          where: { tenantId },
        },
        appliedPromotion: { where: { tenantId } },
      },
    });

    if (!saleData) return null;

    const sale = Sale.fromPersistence({
      id: saleData.id,
      userId: saleData.userId,
      status: saleData.status as SaleStatus,
      channel: saleData.channel as 'POS' | 'ONLINE',
      register: saleData.register,
      deliveryStatus: saleData.deliveryStatus as
        | 'PENDING'
        | 'DELIVERED'
        | 'NOT_APPLICABLE',
      customerId: saleData.customerId,
      shippingAddressId: saleData.shippingAddressId,
      sellerUserId: saleData.sellerUserId,
      dueDate: saleData.dueDate,
      confirmedAt: saleData.confirmedAt,
      folio: saleData.folio,
      items: saleData.items.map((item) => ({
        id: item.id,
        saleId: item.saleId,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        unitPriceCurrency: item.unitPriceCurrency,
        originalPriceCents: item.originalPriceCents,
        priceSource: item.priceSource?.toLowerCase() as
          | 'default'
          | 'price_list'
          | 'custom'
          | undefined,
        appliedPriceListId: item.appliedPriceListId,
        customPriceCents: item.customPriceCents,
        discountType: item.discountType as 'amount' | 'percentage' | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents,
        // WU3 — round-trip the persisted BXGY reward percent on reload so a
        // subsequent re-save does not wipe it.
        rewardDiscountPercent: item.rewardDiscountPercent ?? null,
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
        promotionId: item.promotionId ?? null,
      })),
      createdAt: saleData.createdAt,
      updatedAt: saleData.updatedAt,
      appliedOrderPromotion: saleData.appliedPromotion
        ? {
            promotionId: saleData.appliedPromotion.promotionId ?? null,
            discountType:
              (saleData.appliedPromotion.discountType as
                | 'amount'
                | 'percentage'
                | null) ?? null,
            discountValue: saleData.appliedPromotion.discountValue ?? null,
            discountAmountCents: saleData.appliedPromotion.discountAmountCents,
            discountTitle: saleData.appliedPromotion.discountTitle ?? null,
          }
        : null,
      vetoedPromotionIds: (
        (saleData.promotionVetoes as Array<{ promotionId: string }>) ?? []
      ).map((v) => v.promotionId),
      optedInManualPromotionIds: (
        (saleData.promotionOptIns as Array<{ promotionId: string }>) ?? []
      ).map((o) => o.promotionId),
    });

    return {
      ...sale.toResponse(),
      // Order-discount-aware totals for the draft preview. As of the
      // `fix(sales): surface preview totals for draft toResponse` change,
      // `sale.toResponse()` ALREADY spreads `previewTotals()` when the sale
      // is in DRAFT status, so the explicit `...sale.previewTotals()`
      // spread below is now redundant for DRAFT — it re-applies identical
      // values. We keep it explicitly (rather than removing it) because
      // (a) it is harmless — same numbers, no double-count, and the
      // regression-guard test in prisma-sale.repository.spec.ts ("does NOT
      // double-count when a draft has BOTH a per-line discount AND an
      // order-level promotion") proves this — and (b) it makes the data
      // flow self-documenting at this call site: a future reader sees that
      // the preview totals are the source of truth here without having to
      // chase the DRAFT branch in `Sale.toResponse()`. Same helper the
      // charge path uses (Unit 5) — single source of truth, no math
      // duplication.
      ...sale.previewTotals(),
      customer: saleData.customer
        ? {
            id: saleData.customer.id,
            firstName: saleData.customer.firstName,
            lastName: saleData.customer.lastName,
          }
        : null,
      shippingAddress: saleData.shippingAddress
        ? {
            id: saleData.shippingAddress.id,
            street: saleData.shippingAddress.street,
            exteriorNumber: saleData.shippingAddress.exteriorNumber,
            interiorNumber: saleData.shippingAddress.interiorNumber,
            zipCode: saleData.shippingAddress.zipCode,
            neighborhood: saleData.shippingAddress.neighborhood,
            municipality: saleData.shippingAddress.municipality,
            city: saleData.shippingAddress.city,
            state: saleData.shippingAddress.state,
          }
        : null,
    };
  }

  async findDraftsByUserId(userId: string): Promise<Sale[]> {
    const prisma = this.tenantPrisma.getClient();
    // See findById above for why we pass `where: { tenantId }` on the
    // promotion-junction includes (createTenantScopedPrisma does NOT
    // recurse into nested includes; the convention is to filter
    // EXPLICITLY — same as price-lists.service.ts).
    const tenantId = this.requireTenantId();
    const sales = await prisma.sale.findMany({
      where: {
        userId,
        status: 'DRAFT',
      },
      include: {
        items: true,
        shippingAddress: { select: { id: true } },
        // Unit 3 — W2: load veto + applied-promo on the draft-list path too.
        promotionVetoes: { select: { promotionId: true }, where: { tenantId } },
        // Unit 6 close-out: load MANUAL opt-in set on the draft-list path so
        // every draft the user owns surfaces its opt-in state.
        promotionOptIns: { select: { promotionId: true }, where: { tenantId } },
        appliedPromotion: { where: { tenantId } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return sales.map((saleData) =>
      Sale.fromPersistence({
        id: (saleData as any).id,
        userId: (saleData as any).userId,
        status: (saleData as any).status as SaleStatus,
        channel: (saleData as any).channel as 'POS' | 'ONLINE',
        register: (saleData as any).register,
        deliveryStatus: (saleData as any).deliveryStatus as
          | 'PENDING'
          | 'DELIVERED'
          | 'NOT_APPLICABLE',
        customerId: (saleData as any).customerId,
        shippingAddressId: (saleData as any).shippingAddressId,
        sellerUserId: (saleData as any).sellerUserId,
        dueDate: (saleData as any).dueDate,
        items: (saleData as any).items.map((item) => ({
          id: item.id,
          saleId: item.saleId,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: item.unitPriceCurrency,
          originalPriceCents: item.originalPriceCents,
          priceSource: item.priceSource?.toLowerCase() as
            | 'default'
            | 'price_list'
            | 'custom'
            | undefined,
          appliedPriceListId: item.appliedPriceListId,
          customPriceCents: item.customPriceCents,
          discountType: item.discountType as 'amount' | 'percentage' | null,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          // WU3 — round-trip the persisted BXGY reward percent on reload.
          rewardDiscountPercent: item.rewardDiscountPercent ?? null,
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
          promotionId: item.promotionId ?? null,
        })),
        confirmedAt: (saleData as any).confirmedAt,
        folio: (saleData as any).folio,
        createdAt: (saleData as any).createdAt,
        updatedAt: (saleData as any).updatedAt,
        appliedOrderPromotion: (saleData as any).appliedPromotion
          ? {
              promotionId:
                (saleData as any).appliedPromotion.promotionId ?? null,
              discountType:
                ((saleData as any).appliedPromotion.discountType as
                  | 'amount'
                  | 'percentage'
                  | null) ?? null,
              discountValue:
                (saleData as any).appliedPromotion.discountValue ?? null,
              discountAmountCents: (saleData as any).appliedPromotion
                .discountAmountCents,
              discountTitle:
                (saleData as any).appliedPromotion.discountTitle ?? null,
            }
          : null,
        vetoedPromotionIds: (
          ((saleData as any).promotionVetoes as Array<{
            promotionId: string;
          }>) ?? []
        ).map((v) => v.promotionId),
        optedInManualPromotionIds: (
          ((saleData as any).promotionOptIns as Array<{
            promotionId: string;
          }>) ?? []
        ).map((o) => o.promotionId),
      }),
    );
  }

  async findByIdForUpdate(id: string): Promise<Sale | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    await prisma.$queryRaw`
      SELECT id
      FROM sales
      WHERE id = ${id} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;
    // Same `where: { tenantId }` pattern as the other read paths — see
    // findById for the full rationale (createTenantScopedPrisma does NOT
    // recurse into nested includes; the convention is to filter
    // EXPLICITLY).
    const saleData = await prisma.sale.findFirst({
      where: { id, tenantId },
      include: {
        items: true,
        shippingAddress: { select: { id: true } },
        // Unit 3 — W2: charge path needs veto + applied-promo so the
        // charge-time recompute excludes vetoed ids and keeps the order
        // discount consistent with the draft preview.
        promotionVetoes: { select: { promotionId: true }, where: { tenantId } },
        // Unit 6 close-out: charge path needs the MANUAL opt-in set so the
        // charge-time recompute respects the seller's manual picks.
        promotionOptIns: { select: { promotionId: true }, where: { tenantId } },
        appliedPromotion: { where: { tenantId } },
      },
    });

    if (!saleData) return null;

    const persistedSale = saleData as any;

    return Sale.fromPersistence({
      id: persistedSale.id,
      userId: persistedSale.userId,
      status: persistedSale.status as SaleStatus,
      channel: persistedSale.channel as 'POS' | 'ONLINE',
      register: persistedSale.register,
      deliveryStatus: persistedSale.deliveryStatus as
        | 'PENDING'
        | 'SHIPPED'
        | 'DELIVERED'
        | 'NOT_APPLICABLE',
      customerId: persistedSale.customerId,
      shippingAddressId: persistedSale.shippingAddressId,
      sellerUserId: persistedSale.sellerUserId,
      dueDate: persistedSale.dueDate,
      confirmedAt: persistedSale.confirmedAt,
      folio: persistedSale.folio,
      totalCents: persistedSale.totalCents,
      paidCents: persistedSale.paidCents,
      debtCents: persistedSale.debtCents,
      changeDueCents: persistedSale.changeDueCents,
      paymentStatus: persistedSale.paymentStatus,
      canceledAt: persistedSale.canceledAt,
      cancelReason: persistedSale.cancelReason,
      canceledByUserId: persistedSale.canceledByUserId,
      items: persistedSale.items.map((item) => ({
        id: item.id,
        saleId: item.saleId,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        unitPriceCurrency: item.unitPriceCurrency,
        originalPriceCents: item.originalPriceCents,
        priceSource: item.priceSource?.toLowerCase() as
          | 'default'
          | 'price_list'
          | 'custom'
          | undefined,
        appliedPriceListId: item.appliedPriceListId,
        customPriceCents: item.customPriceCents,
        discountType: item.discountType as 'amount' | 'percentage' | null,
        discountValue: item.discountValue,
        discountAmountCents: item.discountAmountCents,
        // WU3 — round-trip the persisted BXGY reward percent on reload so a
        // subsequent re-save does not wipe it.
        rewardDiscountPercent: item.rewardDiscountPercent ?? null,
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
        promotionId: item.promotionId ?? null,
      })),
      createdAt: persistedSale.createdAt,
      updatedAt: persistedSale.updatedAt,
      appliedOrderPromotion: persistedSale.appliedPromotion
        ? {
            promotionId: persistedSale.appliedPromotion.promotionId ?? null,
            discountType:
              (persistedSale.appliedPromotion.discountType as
                | 'amount'
                | 'percentage'
                | null) ?? null,
            discountValue: persistedSale.appliedPromotion.discountValue ?? null,
            discountAmountCents:
              persistedSale.appliedPromotion.discountAmountCents,
            discountTitle: persistedSale.appliedPromotion.discountTitle ?? null,
          }
        : null,
      vetoedPromotionIds: (
        (persistedSale.promotionVetoes as Array<{ promotionId: string }>) ?? []
      ).map((v) => v.promotionId),
      optedInManualPromotionIds: (
        (persistedSale.promotionOptIns as Array<{ promotionId: string }>) ?? []
      ).map((o) => o.promotionId),
    });
  }

  async persistCancellation(
    sale: Sale,
    refunds: PersistedSaleRefundRecord[],
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    await prisma.sale.updateMany({
      where: { id: sale.id, tenantId },
      data: {
        status: 'CANCELED',
        canceledAt: sale.canceledAt,
        cancelReason: sale.cancelReason,
        canceledByUserId: sale.canceledByUserId,
        debtCents: sale.paymentStatus === 'CREDIT' ? 0 : sale.debtCents,
      },
    });

    if (refunds.length === 0) {
      return;
    }

    await prisma.saleRefund.createMany({
      data: refunds.map((refund) => ({
        tenantId,
        saleId: sale.id,
        salePaymentId: refund.salePaymentId,
        method: refund.method.toUpperCase() as
          | 'CASH'
          | 'CARD_CREDIT'
          | 'CARD_DEBIT'
          | 'TRANSFER'
          | 'CREDIT',
        amountCents: refund.amountCents,
        reason: refund.reason,
      })),
    });
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.tenantPrisma.runInTransaction(work);
  }

  async allocateNextFolio(now = new Date()): Promise<string> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const period = `${year}${month}`;

    const counter = await prisma.saleFolioCounter.upsert({
      where: { tenantId_period: { tenantId, period } },
      create: { tenantId, period, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });

    return `A-${period}-${String(counter.lastNumber).padStart(6, '0')}`;
  }

  async persistChargeConfirmation(input: {
    saleId: string;
    userId: string;
    payments: PersistedChargePayment[];
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    changeDueCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    channel?: 'POS' | 'ONLINE';
    register?: string;
    deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
    customerId?: string | null;
    sellerUserId?: string | null;
    dueDate?: Date | null;
    confirmedAt: Date;
    folio: string;
    /**
     * Work Unit 5 — W1 fix. When provided, the SaleItem rows are
     * deleteMany + createMany-re-written INSIDE the charge tx so the
     * charge-time recomputed per-line promo state (promotionId /
     * discountAmountCents / unitPriceCents) is persisted alongside the
     * charged total. Same pattern as `save` (which already re-writes items
     * outside the charge path). When omitted, no item re-write happens
     * (back-compat for non-promo charges — keep the previous behavior).
     */
    items?: ReadonlyArray<SaleItem>;
    /**
     * Work Unit 5 — C2 audit. When provided (incl. explicit null), the
     * `sale_promotion_applied` row is upserted (non-null) or deleted
     * (null). When omitted entirely, the table is left alone (back-compat).
     */
    appliedOrderPromotion?: AppliedOrderPromotionSnapshot | null;
  }): Promise<PersistedSalePaymentRecord[]> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    // Build the update payload from the always-set fields plus any optional
    // fields that the caller EXPLICITLY provided (including explicit null,
    // which means "clear the column"). Fields absent from the input are NOT
    // included in the payload — that way they keep whatever value the row
    // already has (e.g. customerId / sellerUserId inherited from the draft).
    //
    // The previous defensive `?? null` pattern was destructive: when the
    // service forgot to pass customerId, the repo overwrote the draft's
    // customerId with null, which caused confirmed sales to lose their
    // customer in the listing.
    const data: Prisma.SaleUncheckedUpdateManyInput = {
      status: 'CONFIRMED',
      subtotalCents: input.subtotalCents,
      discountCents: input.discountCents,
      totalCents: input.totalCents,
      paidCents: input.paidCents,
      debtCents: input.debtCents,
      changeDueCents: input.changeDueCents,
      paymentStatus: input.paymentStatus,
      confirmedAt: input.confirmedAt,
      folio: input.folio,
    };
    if (input.channel !== undefined) data.channel = input.channel;
    if (input.register !== undefined) data.register = input.register;
    if (input.deliveryStatus !== undefined)
      data.deliveryStatus = input.deliveryStatus;
    if ('customerId' in input) data.customerId = input.customerId ?? null;
    if ('sellerUserId' in input) data.sellerUserId = input.sellerUserId ?? null;
    if ('dueDate' in input) data.dueDate = input.dueDate ?? null;

    // Work Unit 5 — W1 in-tx SaleItem re-write. Must run inside the SAME
    // `runInTransaction` block as the Sale.updateMany + SalePayment.create
    // calls below — so the audit (promotionId / discountAmountCents /
    // unitPriceCents) commits or rolls back atomically with the charged
    // total. `persistChargeConfirmation` already runs inside the charge
    // tx (chargeDraft calls `saleRepo.runInTransaction` then this method),
    // and `tenantPrisma.getClient()` resolves to the tx client via CLS.
    if (input.items !== undefined) {
      await prisma.saleItem.deleteMany({
        where: { saleId: input.saleId },
      });
      if (input.items.length > 0) {
        await prisma.saleItem.createMany({
          data: input.items.map((item) => ({
            id: item.id,
            saleId: item.saleId,
            productId: item.productId,
            variantId: item.variantId,
            productName: item.productName,
            variantName: item.variantName,
            imageUrl: item.imageUrl,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            unitPriceCurrency: item.unitPriceCurrency,
            originalPriceCents: item.originalPriceCents,
            priceSource:
              item.priceSource === 'default'
                ? 'DEFAULT'
                : item.priceSource === 'price_list'
                  ? 'PRICE_LIST'
                  : 'CUSTOM',
            appliedPriceListId: item.appliedPriceListId,
            customPriceCents: item.customPriceCents,
            discountType: item.discountType,
            discountValue: item.discountValue,
            discountAmountCents: item.discountAmountCents,
            // WU3 — persist the exact BXGY reward percent from the entity.
            rewardDiscountPercent: item.rewardDiscountPercent,
            prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
            discountTitle: item.discountTitle,
            discountedAt: item.discountedAt,
            promotionId: item.promotionId,
            tenantId,
          })) as Prisma.SaleItemCreateManyInput[],
        });
      }
    }

    // Work Unit 5 — C2 audit. The sale-level ORDER_DISCOUNT snapshot may
    // have been set / cleared at charge time by the recompute. Explicit
    // null means "no order promo applies this run" — delete any prior row.
    // Omitted entirely means "back-compat — do not touch the table".
    if (input.appliedOrderPromotion !== undefined) {
      if (input.appliedOrderPromotion === null) {
        await prisma.salePromotionApplied.deleteMany({
          where: { saleId: input.saleId, tenantId },
        });
      } else {
        const snap = input.appliedOrderPromotion;
        await prisma.salePromotionApplied.upsert({
          where: { saleId: input.saleId },
          create: {
            saleId: input.saleId,
            tenantId,
            promotionId: snap.promotionId,
            discountType: snap.discountType,
            discountValue: snap.discountValue,
            discountAmountCents: snap.discountAmountCents,
            discountTitle: snap.discountTitle,
          },
          update: {
            promotionId: snap.promotionId,
            discountType: snap.discountType,
            discountValue: snap.discountValue,
            discountAmountCents: snap.discountAmountCents,
            discountTitle: snap.discountTitle,
          },
        });
      }
    }

    await prisma.sale.updateMany({
      where: { id: input.saleId, tenantId },
      data,
    });

    const createdPayments = await Promise.all(
      input.payments.map((payment) =>
        prisma.salePayment.create({
          data: {
            saleId: input.saleId,
            method: payment.method.toUpperCase() as
              | 'CASH'
              | 'CARD_CREDIT'
              | 'CARD_DEBIT'
              | 'TRANSFER',
            amountCents: payment.amountCents,
            reference: payment.reference ?? null,
            userId: input.userId,
            tenantId,
          },
          select: {
            id: true,
            method: true,
            amountCents: true,
            reference: true,
          },
        }),
      ),
    );

    return createdPayments.map((payment) => ({
      paymentId: payment.id,
      method: payment.method.toLowerCase() as
        | 'cash'
        | 'card_credit'
        | 'card_debit'
        | 'transfer',
      amountCents: payment.amountCents,
      reference: payment.reference,
    }));
  }

  async persistCollectedPayment(input: {
    saleId: string;
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    amountCents: number;
    reference?: string | null;
    userId: string | null;
    metadataJson?: unknown;
  }): Promise<{
    paymentId: string;
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }> {
    const result = await this.persistCollectedPayments({
      saleId: input.saleId,
      userId: input.userId,
      payments: [
        {
          method: input.method,
          amountCents: input.amountCents,
          reference: input.reference,
          metadataJson: input.metadataJson,
        },
      ],
    });

    return {
      paymentId: result.paymentIds[0],
      paidCents: result.paidCents,
      debtCents: result.debtCents,
      paymentStatus: result.paymentStatus,
      totalCents: result.totalCents,
    };
  }

  async persistCollectedPayments(input: {
    saleId: string;
    userId: string | null;
    payments: Array<{
      method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
      amountCents: number;
      reference?: string | null;
      metadataJson?: unknown;
    }>;
  }): Promise<{
    paymentIds: string[];
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    totalCents: number;
  }> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    const sale = await prisma.sale.findFirst({
      where: { id: input.saleId, tenantId, status: 'CONFIRMED' },
      select: { totalCents: true },
    });
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const aggregate = await prisma.salePayment.aggregate({
      where: { saleId: input.saleId, tenantId },
      _sum: { amountCents: true },
    });
    const paidFromLedger = aggregate._sum.amountCents ?? 0;
    if (paidFromLedger >= sale.totalCents) {
      throw new BusinessRuleViolationError(
        'NO_OUTSTANDING_DEBT',
        'NO_OUTSTANDING_DEBT',
      );
    }
    const batchTotal = input.payments.reduce(
      (sum, payment) => sum + payment.amountCents,
      0,
    );
    const recomputedPaidCents = paidFromLedger + batchTotal;
    if (recomputedPaidCents > sale.totalCents) {
      throw new BusinessRuleViolationError(
        'PAYMENT_EXCEEDS_DEBT',
        'PAYMENT_EXCEEDS_DEBT',
      );
    }

    const recomputedDebtCents = sale.totalCents - recomputedPaidCents;
    const paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' =
      recomputedPaidCents === sale.totalCents
        ? 'PAID'
        : recomputedPaidCents === 0
          ? 'CREDIT'
          : 'PARTIAL';

    const paymentIds = input.payments.map(() => randomUUID());

    await prisma.salePayment.createMany({
      data: input.payments.map((payment, index) => ({
        id: paymentIds[index],
        saleId: input.saleId,
        method: payment.method.toUpperCase() as
          | 'CASH'
          | 'CARD_CREDIT'
          | 'CARD_DEBIT'
          | 'TRANSFER',
        amountCents: payment.amountCents,
        reference: payment.reference ?? null,
        metadataJson:
          payment.metadataJson === undefined
            ? Prisma.JsonNull
            : (payment.metadataJson as Prisma.InputJsonValue),
        userId: input.userId,
        tenantId,
      })),
    });

    await prisma.sale.updateMany({
      where: { id: input.saleId, tenantId },
      data: {
        paidCents: recomputedPaidCents,
        debtCents: recomputedDebtCents,
        paymentStatus,
      },
    });

    return {
      paymentIds,
      paidCents: recomputedPaidCents,
      debtCents: recomputedDebtCents,
      paymentStatus,
      totalCents: sale.totalCents,
    };
  }

  private buildBaseWhere(input: SalesListBaseFilter): Prisma.SaleWhereInput {
    const where: Prisma.SaleWhereInput = {
      status: 'CONFIRMED',
    };

    if (input.cashierUserId?.length) {
      where.userId = { in: input.cashierUserId };
    }

    if (input.customerId?.length && input.customerIncludeNull) {
      where.OR = [
        { customerId: { in: input.customerId } },
        { customerId: null },
      ];
    } else if (input.customerId?.length) {
      where.customerId = { in: input.customerId };
    } else if (input.customerIncludeNull) {
      where.customerId = null;
    }

    if (input.confirmedFrom || input.confirmedTo) {
      where.confirmedAt = {
        ...(input.confirmedFrom ? { gte: input.confirmedFrom } : {}),
        ...(input.confirmedTo ? { lte: input.confirmedTo } : {}),
      };
    }

    if (input.q?.trim()) {
      const q = input.q.trim();
      const qOrClauses: Prisma.SaleWhereInput[] = [
        { customer: { firstName: { contains: q, mode: 'insensitive' } } },
        { customer: { lastName: { contains: q, mode: 'insensitive' } } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { seller: { name: { contains: q, mode: 'insensitive' } } },
      ];

      // Folio search: if q is purely numeric, match against the sequence
      // suffix (endsWith padded) to avoid false positives from year/month.
      // Otherwise, use standard contains.
      if (/^\d+$/.test(q)) {
        const padded = q.padStart(6, '0');
        qOrClauses.push({ folio: { endsWith: padded, mode: 'insensitive' } });
      } else {
        qOrClauses.push({ folio: { contains: q, mode: 'insensitive' } });
      }

      // "Público en General" virtual match: when q matches common tokens,
      // include sales with no customer assigned.
      const normalized = q
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const publicTokens = ['publico', 'general', 'publico en general'];
      if (
        publicTokens.some(
          (token) => token.includes(normalized) || normalized.includes(token),
        )
      ) {
        qOrClauses.push({ customerId: null });
      }

      const qClause: Prisma.SaleWhereInput = { OR: qOrClauses };
      const existingCustomerOr = Array.isArray(where.OR)
        ? [...where.OR]
        : undefined;

      if (existingCustomerOr) {
        delete where.OR;
        const existingAnd = where.AND
          ? Array.isArray(where.AND)
            ? where.AND
            : [where.AND]
          : [];
        where.AND = [...existingAnd, { OR: existingCustomerOr }, qClause];
      } else {
        if (
          where.customerId === null &&
          qOrClauses.some((clause) => clause.customerId === null)
        ) {
          delete where.customerId;
        }
        where.OR = qOrClauses;
      }
    }

    return where;
  }

  private buildExtendedWhere(
    input: SalesListExtendedFilter,
  ): Prisma.SaleWhereInput {
    const base = this.buildBaseWhere(input);
    const andClauses: Prisma.SaleWhereInput[] = [base];

    if (input.status?.length) {
      // When an explicit status filter is supplied, remove the default
      // status:'CONFIRMED' that buildBaseWhere adds. Without this, the generated
      // WHERE becomes status='CONFIRMED' AND status IN (...) — a logical
      // contradiction when filtering for e.g. CANCELED (always returns 0 rows).
      // The CONFIRMED default is only meaningful when no explicit status is given;
      // KPI/countConfirmed paths call buildBaseWhere directly and are unaffected.
      delete (base as { status?: unknown }).status;
      andClauses.push({
        status: { in: input.status },
      });
    }

    if (input.paymentStatus?.length) {
      andClauses.push({ paymentStatus: { in: input.paymentStatus } });
    }

    if (input.deliveryStatus?.length) {
      andClauses.push({ deliveryStatus: { in: input.deliveryStatus } });
    }

    if (input.folio?.length) {
      andClauses.push({ folio: { in: input.folio } });
    }

    if (input.totalMin !== undefined || input.totalMax !== undefined) {
      andClauses.push({
        totalCents: {
          ...(input.totalMin !== undefined ? { gte: input.totalMin } : {}),
          ...(input.totalMax !== undefined ? { lte: input.totalMax } : {}),
        },
      });
    }

    if (input.debtMin !== undefined || input.debtMax !== undefined) {
      andClauses.push({
        debtCents: {
          ...(input.debtMin !== undefined ? { gte: input.debtMin } : {}),
          ...(input.debtMax !== undefined ? { lte: input.debtMax } : {}),
        },
      });
    }

    if (input.dueDateFrom || input.dueDateTo) {
      const dueDateRange = {
        ...(input.dueDateFrom ? { gte: input.dueDateFrom } : {}),
        ...(input.dueDateTo ? { lte: input.dueDateTo } : {}),
      };
      andClauses.push(
        input.dueDateIncludeNull
          ? { OR: [{ dueDate: dueDateRange }, { dueDate: null }] }
          : { dueDate: dueDateRange },
      );
    } else if (input.dueDateIncludeNull) {
      andClauses.push({ dueDate: null });
    }

    if (input.paymentMethod?.length) {
      const somePaymentMethod = {
        payments: { some: { method: { in: input.paymentMethod } } },
      };
      andClauses.push(
        input.paymentMethodIncludeNull
          ? { OR: [somePaymentMethod, { payments: { none: {} } }] }
          : somePaymentMethod,
      );
    } else if (input.paymentMethodIncludeNull) {
      andClauses.push({ payments: { none: {} } });
    }

    return andClauses.length === 1 ? andClauses[0] : { AND: andClauses };
  }

  async findManyConfirmed(
    input: SalesListExtendedFilter & {
      page: number;
      limit: number;
      sortBy: 'confirmedAt' | 'totalCents' | 'createdAt';
      sortOrder: 'asc' | 'desc';
    },
  ) {
    const prisma = this.tenantPrisma.getClient();
    const where = this.buildExtendedWhere(input);

    const rows = await prisma.sale.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        user: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        payments: { select: { method: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { [input.sortBy]: input.sortOrder },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      folio: row.folio,
      status: row.status,
      paymentStatus: row.paymentStatus,
      deliveryStatus: row.deliveryStatus,
      totalCents: row.totalCents,
      debtCents: row.debtCents ?? 0,
      confirmedAt: row.confirmedAt,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      customer: row.customer
        ? {
            id: row.customer.id,
            name: row.customer.lastName
              ? `${row.customer.firstName} ${row.customer.lastName}`
              : row.customer.firstName,
          }
        : null,
      cashier: row.user,
      seller: row.seller,
      paymentMethods: [...new Set(row.payments.map((p) => p.method))],
    }));
  }

  async countConfirmed(input: SalesListBaseFilter): Promise<number> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.sale.count({ where: this.buildBaseWhere(input) });
  }

  async groupByPaymentStatusConfirmed(input: SalesListBaseFilter): Promise<
    Array<{
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
      _count: { _all: number };
    }>
  > {
    const prisma = this.tenantPrisma.getClient();
    const grouped = await prisma.sale.groupBy({
      by: ['paymentStatus'],
      where: this.buildBaseWhere(input),
      _count: { _all: true },
    });

    return grouped as Array<{
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
      _count: { _all: number };
    }>;
  }

  async countNotDeliveredConfirmed(
    input: SalesListBaseFilter,
  ): Promise<number> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.sale.count({
      where: {
        ...this.buildBaseWhere(input),
        NOT: { deliveryStatus: 'DELIVERED' },
      },
    });
  }

  async findOneWithRelations(id: string) {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    const sale = await prisma.sale.findFirst({
      where: { id, tenantId, status: 'CONFIRMED' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        user: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        items: {
          select: {
            productName: true,
            variantName: true,
            imageUrl: true,
            unitPriceCents: true,
            quantity: true,
            originalPriceCents: true,
            priceSource: true,
            appliedPriceListId: true,
            discountType: true,
            discountValue: true,
            discountAmountCents: true,
            discountTitle: true,
            prePriceCentsBeforeDiscount: true,
            // WU3 — the persisted exact BXGY promo percent surfaced on the
            // confirmed detail wire, next to rewardKind.
            rewardDiscountPercent: true,
            // WU2 — needed by the column-derived `isBuyXGetYReward()`
            // discriminator the receipt mapper re-derives on the wire
            // path (design.md Decision 6). The mapper previously omitted
            // this select; BXGY rows would have rendered as GROSS because
            // `promotionId` came back undefined and the predicate failed.
            promotionId: true,
          },
        },
        payments: {
          select: {
            id: true,
            method: true,
            amountCents: true,
            reference: true,
            metadataJson: true,
            createdAt: true,
            userId: true,
            user: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!sale) return null;

    return {
      id: sale.id,
      folio: sale.folio,
      status: sale.status,
      channel: sale.channel,
      register: sale.register,
      confirmedAt: sale.confirmedAt,
      dueDate: sale.dueDate,
      createdAt: sale.createdAt,
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      paidCents: sale.paidCents,
      debtCents: sale.debtCents,
      changeDueCents: sale.changeDueCents,
      paymentStatus: sale.paymentStatus,
      deliveryStatus: sale.deliveryStatus,
      customer: sale.customer
        ? {
            id: sale.customer.id,
            name: sale.customer.lastName
              ? `${sale.customer.firstName} ${sale.customer.lastName}`
              : sale.customer.firstName,
          }
        : null,
      cashier: sale.user,
      seller: sale.seller,
      items: sale.items.map((item) => {
        // Column-derived BXGY discriminator (design.md Decision 6). Same
        // predicate the domain SaleItem.isBuyXGetYReward() reads — we
        // re-derive it here from the persisted Prisma row so the wire
        // path and the domain path agree without sharing state.
        //
        // Unreachable by the per-unit PRODUCT_DISCOUNT path by invariant
        // (that path forces `unitPrice < prePrice` by ≥1 via
        // sale-item.entity.ts:267). Manual free-form discounts leave
        // `promotionId = null` and fail the first clause.
        const isBxgy =
          item.promotionId != null &&
          item.prePriceCentsBeforeDiscount != null &&
          item.unitPriceCents === item.prePriceCentsBeforeDiscount &&
          (item.discountAmountCents ?? 0) > 0;
        const bxgyRewardCents = isBxgy ? item.discountAmountCents ?? 0 : 0;
        return {
          productName: item.productName,
          variantName: item.variantName,
          imageUrl: item.imageUrl,
          unitPriceCents: item.unitPriceCents,
          quantity: item.quantity,
          discountCents: item.discountAmountCents ?? 0,
          // NET subtotal: for BXGY lines `unitPrice × qty` is GROSS (the
          // reward `R` is stored in `discountAmountCents` instead of being
          // amortized into `unitPriceCents`), so we subtract `R` to render
          // NET. For every other line the per-unit path is already NET
          // (unitPrice was reduced by the discount), so `bxgyRewardCents`
          // is zero and the subtraction is a no-op.
          subtotalCents:
            item.unitPriceCents * item.quantity - bxgyRewardCents,
          originalPriceCents: item.originalPriceCents,
          priceSource: item.priceSource?.toLowerCase() as
            | 'default'
            | 'price_list'
            | 'custom'
            | null,
          appliedPriceListId: item.appliedPriceListId,
          discountType: item.discountType as 'amount' | 'percentage' | null,
          discountValue: item.discountValue,
          discountAmountCents: item.discountAmountCents,
          discountTitle: item.discountTitle,
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          // Explicit wire flag so the frontend can render the
          // "free"/reward badge without inferring it.
          rewardKind: isBxgy ? ('buy_x_get_y' as const) : null,
          // WU3 — exact BXGY reward percent (0..100). Null on non-reward
          // lines using the SAME `isBxgy` guard as `rewardKind`, so the
          // frontend shows "GRATIS" only at 100%, else the real percent.
          rewardDiscountPercent: isBxgy
            ? item.rewardDiscountPercent ?? null
            : null,
          // WUA — surface the line's source promotion id on the wire so
          // the frontend can link a confirmed-sale line back to its
          // catalog promo card without inferring it from `discountTitle`.
          // Null on plain lines (no promotion applied) and on lines with
          // a free-form seller discount. Coerce undefined → null so the
          // wire contract is `string | null` (never undefined).
          promotionId: item.promotionId ?? null,
        };
      }),
      payments: sale.payments.map((payment) => ({
        paymentId: payment.id,
        method: payment.method,
        amountCents: payment.amountCents,
        tenderedCents: payment.amountCents,
        changeCents: 0,
        reference:
          payment.reference ?? extractLegacyReference(payment.metadataJson),
        paidAt: payment.createdAt,
        createdAt: payment.createdAt,
        userId: payment.userId,
        user: payment.user,
      })),
    };
  }

  async acquireChargeIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  > {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    const operation = 'sale_charge';

    try {
      const created = await prisma.saleIdempotency.create({
        data: {
          tenantId,
          operation,
          key,
          requestHash,
          status: 'IN_FLIGHT',
          saleId,
        },
      });

      return { kind: 'acquired', token: created.id };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) &&
        !(typeof error === 'object' && error !== null && 'code' in error)
      ) {
        throw error;
      }

      const prismaCode =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : String((error as { code?: string }).code ?? '');
      if (prismaCode !== 'P2002') {
        throw error;
      }

      const existing = await prisma.saleIdempotency.findUnique({
        where: {
          tenantId_operation_key: {
            tenantId,
            operation,
            key,
          },
        },
      });

      if (!existing) {
        throw new BusinessRuleViolationError(
          'IDEMPOTENCY_STATE_NOT_FOUND',
          'IDEMPOTENCY_STATE_NOT_FOUND',
        );
      }

      if (existing.requestHash !== requestHash) return { kind: 'conflict' };
      if (existing.status === 'SUCCEEDED' && existing.responseJson)
        return { kind: 'replay', payload: existing.responseJson };
      return { kind: 'in_flight' };
    }
  }

  async markChargeIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    await prisma.saleIdempotency.updateMany({
      where: {
        id: token,
        tenantId,
      },
      data: {
        status: 'SUCCEEDED',
        responseJson: payload as Prisma.InputJsonValue,
        saleId,
      },
    });
  }

  async acquirePaymentIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ) {
    return this.acquireIdempotency('sale_payment', saleId, key, requestHash);
  }

  async markPaymentIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void> {
    return this.markIdempotencySucceeded(token, saleId, payload);
  }

  async acquireCancellationIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ) {
    return this.acquireIdempotency('sale_cancel', saleId, key, requestHash);
  }

  async markCancellationIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ): Promise<void> {
    return this.markIdempotencySucceeded(token, saleId, payload);
  }

  private async acquireIdempotency(
    operation: 'sale_charge' | 'sale_payment' | 'sale_cancel',
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  > {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    try {
      const created = await prisma.saleIdempotency.create({
        data: {
          tenantId,
          operation,
          key,
          requestHash,
          status: 'IN_FLIGHT',
          saleId,
        },
      });

      return { kind: 'acquired', token: created.id };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) &&
        !(typeof error === 'object' && error !== null && 'code' in error)
      ) {
        throw error;
      }

      const prismaCode =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : String((error as { code?: string }).code ?? '');
      if (prismaCode !== 'P2002') {
        throw error;
      }

      const existing = await prisma.saleIdempotency.findUnique({
        where: {
          tenantId_operation_key: {
            tenantId,
            operation,
            key,
          },
        },
      });

      if (!existing) {
        throw new BusinessRuleViolationError(
          'IDEMPOTENCY_STATE_NOT_FOUND',
          'IDEMPOTENCY_STATE_NOT_FOUND',
        );
      }

      if (existing.requestHash !== requestHash) return { kind: 'conflict' };
      if (existing.status === 'SUCCEEDED' && existing.responseJson)
        return { kind: 'replay', payload: existing.responseJson };
      return { kind: 'in_flight' };
    }
  }

  private async markIdempotencySucceeded(
    token: string,
    saleId: string,
    payload: unknown,
  ) {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    await prisma.saleIdempotency.updateMany({
      where: {
        id: token,
        tenantId,
      },
      data: {
        status: 'SUCCEEDED',
        responseJson: payload as Prisma.InputJsonValue,
        saleId,
      },
    });
  }

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.sale.delete({
      where: { id },
    });
  }
}
