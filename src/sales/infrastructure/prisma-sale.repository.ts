/**
 * PrismaSaleRepository - Infrastructure adapter for ISaleRepository.
 *
 * Implements persistence operations for Sales using Prisma ORM.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ISaleRepository } from '../domain/sale.repository';
import { Sale, type SaleStatus } from '../domain/sale.entity';
import { Prisma } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

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
      sellerUserId: sale.sellerUserId,
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
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
          tenantId,
        })) as Prisma.SaleItemCreateManyInput[],
      });
    } else {
      // Explicitly handle empty items (for clearItems case)
      await prisma.saleItem.createMany({ data: [] });
    }

    // Reload and return
    return (await this.findById(sale.id))!;
  }

  async findById(id: string): Promise<Sale | null> {
    const prisma = this.tenantPrisma.getClient();
    const saleData = await prisma.sale.findUnique({
      where: { id },
      include: { items: true },
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
      sellerUserId: persistedSale.sellerUserId,
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
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
      })),
      createdAt: persistedSale.createdAt,
      updatedAt: persistedSale.updatedAt,
    });
  }

  async findDraftsByUserId(userId: string): Promise<Sale[]> {
    const prisma = this.tenantPrisma.getClient();
    const sales = await prisma.sale.findMany({
      where: {
        userId,
        status: 'DRAFT',
      },
      include: { items: true },
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
        sellerUserId: (saleData as any).sellerUserId,
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
          prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
          discountTitle: item.discountTitle,
          discountedAt: item.discountedAt,
        })),
        confirmedAt: (saleData as any).confirmedAt,
        folio: (saleData as any).folio,
        createdAt: (saleData as any).createdAt,
        updatedAt: (saleData as any).updatedAt,
      }),
    );
  }

  async findByIdForUpdate(id: string): Promise<Sale | null> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();
    const saleData = await prisma.sale.findFirst({
      where: { id, tenantId },
      include: { items: true },
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
      sellerUserId: persistedSale.sellerUserId,
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
        prePriceCentsBeforeDiscount: item.prePriceCentsBeforeDiscount,
        discountTitle: item.discountTitle,
        discountedAt: item.discountedAt,
      })),
      createdAt: persistedSale.createdAt,
      updatedAt: persistedSale.updatedAt,
    });
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.$transaction(async () => work());
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
    method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    amountCents: number;
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
    confirmedAt: Date;
    folio: string;
  }): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.requireTenantId();

    await prisma.sale.updateMany({
      where: { id: input.saleId, tenantId },
      data: {
        status: 'CONFIRMED',
        subtotalCents: input.subtotalCents,
        discountCents: input.discountCents,
        totalCents: input.totalCents,
        paidCents: input.paidCents,
        debtCents: input.debtCents,
        changeDueCents: input.changeDueCents,
        paymentStatus: input.paymentStatus,
        channel: input.channel ?? 'POS',
        register: input.register ?? 'Principal',
        deliveryStatus: input.deliveryStatus ?? 'DELIVERED',
        customerId: input.customerId ?? null,
        sellerUserId: input.sellerUserId ?? null,
        confirmedAt: input.confirmedAt,
        folio: input.folio,
      },
    });

    await prisma.salePayment.create({
      data: {
        saleId: input.saleId,
        method: input.method.toUpperCase() as
          | 'CASH'
          | 'CARD_CREDIT'
          | 'CARD_DEBIT'
          | 'TRANSFER',
        amountCents: input.amountCents,
        tenantId,
      },
    });
  }

  private buildConfirmedBaseWhere(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Prisma.SaleWhereInput {
    const where: Prisma.SaleWhereInput = {
      status: 'CONFIRMED',
    };

    if (input.cashierUserId) where.userId = input.cashierUserId;
    if (input.customerId) where.customerId = input.customerId;
    if (input.from || input.to) {
      where.confirmedAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      };
    }

    if (input.q?.trim()) {
      const q = input.q.trim();
      where.OR = [
        { folio: { contains: q, mode: 'insensitive' } },
        { customer: { firstName: { contains: q, mode: 'insensitive' } } },
        { customer: { lastName: { contains: q, mode: 'insensitive' } } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { seller: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    return where;
  }

  async findManyConfirmed(input: {
    page: number;
    limit: number;
    sortBy: 'confirmedAt' | 'totalCents' | 'createdAt';
    sortOrder: 'asc' | 'desc';
    q?: string;
    status?: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
    paymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
    deliveryStatus?: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }) {
    const prisma = this.tenantPrisma.getClient();
    const baseWhere = this.buildConfirmedBaseWhere(input);
    const where: Prisma.SaleWhereInput = {
      ...baseWhere,
      ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}),
      ...(input.deliveryStatus ? { deliveryStatus: input.deliveryStatus } : {}),
      ...(input.status && input.status !== 'CANCELED'
        ? { status: input.status }
        : {}),
    };

    const rows = await prisma.sale.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        user: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
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
      confirmedAt: row.confirmedAt,
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
    }));
  }

  async countConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<number> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.sale.count({ where: this.buildConfirmedBaseWhere(input) });
  }

  async groupByPaymentStatusConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<
    Array<{ paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null; _count: { _all: number } }>
  > {
    const prisma = this.tenantPrisma.getClient();
    const grouped = await prisma.sale.groupBy({
      by: ['paymentStatus'],
      where: this.buildConfirmedBaseWhere(input),
      _count: { _all: true },
    });

    return grouped as Array<{
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
      _count: { _all: number };
    }>;
  }

  async countNotDeliveredConfirmed(input: {
    q?: string;
    from?: Date;
    to?: Date;
    cashierUserId?: string;
    customerId?: string;
  }): Promise<number> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.sale.count({
      where: {
        ...this.buildConfirmedBaseWhere(input),
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
            discountAmountCents: true,
          },
        },
        payments: {
          select: {
            method: true,
            amountCents: true,
            createdAt: true,
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
      items: sale.items.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        imageUrl: item.imageUrl,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        discountCents: item.discountAmountCents ?? 0,
        subtotalCents:
          item.unitPriceCents * item.quantity + (item.discountAmountCents ?? 0),
      })),
      payments: sale.payments.map((payment) => ({
        method: payment.method,
        amountCents: payment.amountCents,
        tenderedCents: payment.amountCents,
        changeCents: 0,
        reference: null,
        paidAt: payment.createdAt,
        createdAt: payment.createdAt,
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

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.sale.delete({
      where: { id },
    });
  }
}
