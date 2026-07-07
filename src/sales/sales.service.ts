/**
 * SalesService - Application layer (Use Cases) for POS Sales.
 *
 * Orchestrates domain logic and infrastructure for the Sale aggregate.
 * Handles: draft creation, item management, validation, and ownership enforcement.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'crypto';
import { Sale, type SaleCancelReason } from './domain/sale.entity';
import type { ISaleRepository } from './domain/sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsService } from '../products/products.service';
import {
  EntityNotFoundError,
  BusinessRuleViolationError,
} from '../shared/domain/domain-error';
import {
  SaleDraftOpenedEvent,
  SaleItemAddedEvent,
  SaleItemQuantityChangedEvent,
  SaleClearedEvent,
  SaleDraftDeletedEvent,
  SaleItemPriceOverriddenEvent,
  SaleItemDiscountAppliedEvent,
  SaleItemDiscountRemovedEvent,
  SaleItemRemovedEvent,
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressSetEvent,
  SaleShippingAddressClearedEvent,
} from './domain/events/sale.events';
import type { AddItemDto } from './dto/add-item.dto';
import type { UpdateItemQuantityDto } from './dto/update-item-quantity.dto';
import type { OverrideItemPriceDto } from './dto/override-item-price.dto';
import type { AvailablePricesResponseDto } from './dto/available-prices-response.dto';
import type { ApplyItemDiscountDto } from './dto/apply-item-discount.dto';
import type { ChargeSaleDto } from './dto/charge-sale.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import type {
  SalesListBaseFilter,
  SalesListExtendedFilter,
} from './dto/sales-list-filter.types';
import type { SaleListResponseDto } from './dto/sale-list-response.dto';
import type { SaleDetailResponseDto } from './dto/sale-detail-response.dto';
import type { AssignCustomerDto } from './dto/assign-customer.dto';
import type { AssignSellerDto } from './dto/assign-seller.dto';
import type { SetShippingAddressDto } from './dto/set-shipping-address.dto';
import type { UpdateSaleDueDateDto } from './dto/update-sale-due-date.dto';
import { buildSaleTimeline } from './domain/build-sale-timeline';
import type {
  PersistedChargePayment,
  PersistedSaleRefundRecord,
  PersistedSalePaymentRecord,
} from './domain/sale.repository';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import {
  InvalidDueDateError,
  SaleFullyPaidError,
  SellerNotFoundError,
} from './domain/sale.errors';
import {
  ISaleCommentRepository,
  SALE_COMMENT_REPOSITORY,
} from './comments/domain/sale-comment.repository';

type SupportedChargeMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer'
  | 'credit';

type SupportedPaymentCollectionMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

type CollectionPaymentEntry = {
  method: SupportedPaymentCollectionMethod;
  amountCents: number;
  reference?: string;
  metadataJson?: unknown;
};

type AddPaymentAuthMode = 'owner' | 'reviewer';

type ChargePaymentEntry = {
  method: SupportedChargeMethod;
  amountCents: number;
  reference?: string;
};

type CanonicalChargePayment = PersistedChargePayment;

type ConfirmBotSaleInput = {
  cashierUserId: string;
  customerId: string;
  shippingAddressId?: string | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
};

type ConfirmBotSaleResult = {
  saleId: string;
  folio: string;
  paymentStatus: 'CREDIT';
  channel: 'ONLINE';
  deliveryStatus: 'PENDING';
  totalCents: number;
  paidCents: 0;
  debtCents: number;
  confirmedAt: string;
};

type CancelSaleDto = {
  reason: SaleCancelReason;
};

type CancelSaleResult = {
  saleId: string;
  status: 'CANCELED';
  refundedCents: number;
  restockedItems: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
  }>;
  canceledAt: string;
};

type CancelSaleRefundSource = {
  paymentId: string;
  method: string;
  amountCents: number;
};

function normalizeRefundMethod(
  method: string,
): PersistedSaleRefundRecord['method'] {
  switch (method.toUpperCase()) {
    case 'CASH':
      return 'cash';
    case 'CARD_CREDIT':
      return 'card_credit';
    case 'CARD_DEBIT':
      return 'card_debit';
    case 'TRANSFER':
      return 'transfer';
    case 'CREDIT':
      return 'credit';
    default:
      throw new BusinessRuleViolationError(
        'SALE_REFUND_METHOD_NOT_SUPPORTED',
        'SALE_REFUND_METHOD_NOT_SUPPORTED',
      );
  }
}

function buildCancellationRefunds(
  payments: CancelSaleRefundSource[],
  refundedCents: number,
  reason: SaleCancelReason,
): PersistedSaleRefundRecord[] {
  let remaining = refundedCents;
  const refunds: PersistedSaleRefundRecord[] = [];

  for (const payment of payments) {
    if (remaining <= 0) {
      break;
    }

    const amountCents = Math.min(payment.amountCents, remaining);
    if (amountCents <= 0) {
      continue;
    }

    refunds.push({
      salePaymentId: payment.paymentId,
      method: normalizeRefundMethod(payment.method),
      amountCents,
      reason,
    });
    remaining -= amountCents;
  }

  if (remaining !== 0) {
    throw new BusinessRuleViolationError(
      'SALE_REFUND_AUDIT_MISMATCH',
      'SALE_REFUND_AUDIT_MISMATCH',
    );
  }

  return refunds;
}

function isSupportedChargeMethod(
  method: ChargeSaleDto['method'],
): method is SupportedChargeMethod {
  return ['cash', 'card_credit', 'card_debit', 'transfer', 'credit'].includes(
    method ?? '',
  );
}

function chargeValidationError(
  code:
    | 'INVALID_CREDIT_CHARGE'
    | 'CUSTOMER_REQUIRED_FOR_CREDIT'
    | 'PAYMENT_AMOUNT_INVALID'
    | 'PAYMENT_AMOUNT_INSUFFICIENT'
    | 'AMBIGUOUS_PAYMENT_SHAPE'
    | 'CREDIT_METHOD_NOT_VALID_IN_MULTI'
    | 'REFERENCE_REQUIRED'
    | 'TOO_MANY_PAYMENTS',
): never {
  throw new BusinessRuleViolationError(code, code);
}

function normalizeChargeRequestPayments(
  dto: ChargeSaleDto,
): ChargePaymentEntry[] {
  const hasLegacy = dto.method !== undefined || dto.amountCents !== undefined;
  const hasArray = dto.payments !== undefined;

  if (hasLegacy && hasArray) {
    chargeValidationError('AMBIGUOUS_PAYMENT_SHAPE');
  }

  if (hasArray) {
    const entries = dto.payments ?? [];
    if (entries.length > 5) {
      chargeValidationError('TOO_MANY_PAYMENTS');
    }

    return entries.map((entry) => {
      if (!isSupportedChargeMethod(entry.method)) {
        throw new BusinessRuleViolationError(
          'PAYMENT_METHOD_NOT_SUPPORTED',
          'PAYMENT_METHOD_NOT_SUPPORTED',
        );
      }

      if (entry.method === 'credit') {
        chargeValidationError('CREDIT_METHOD_NOT_VALID_IN_MULTI');
      }

      if (
        ['card_credit', 'card_debit', 'transfer'].includes(entry.method) &&
        (!entry.reference || entry.reference.trim().length === 0)
      ) {
        chargeValidationError('REFERENCE_REQUIRED');
      }

      return {
        method: entry.method,
        amountCents: entry.amountCents,
        reference: entry.reference,
      };
    });
  }

  if (!dto.method || dto.amountCents === undefined) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  if (!isSupportedChargeMethod(dto.method)) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  return [
    {
      method: dto.method,
      amountCents: dto.amountCents,
    },
  ];
}

function toCanonicalChargePayments(
  payments: ChargePaymentEntry[],
): CanonicalChargePayment[] {
  return payments
    .filter(
      (payment): payment is CanonicalChargePayment =>
        payment.method !== 'credit',
    )
    .map((payment) => ({
      method: payment.method,
      amountCents: payment.amountCents,
      reference: payment.reference,
    }));
}

function sortPaymentsForHash(
  payments: ChargePaymentEntry[],
): ChargePaymentEntry[] {
  return [...payments].sort((left, right) =>
    `${left.method}|${left.amountCents}|${left.reference ?? ''}`.localeCompare(
      `${right.method}|${right.amountCents}|${right.reference ?? ''}`,
    ),
  );
}

function resolveDueDate(
  dueDateIso: string | undefined,
  confirmedAt: Date,
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT',
): Date | null {
  if (paymentStatus === 'PAID') {
    return null;
  }

  if (dueDateIso) {
    return new Date(dueDateIso);
  }

  const defaultDueDate = new Date(confirmedAt);
  defaultDueDate.setDate(defaultDueDate.getDate() + 15);
  return defaultDueDate;
}

function isSupportedCollectionMethod(
  method: string,
): method is SupportedPaymentCollectionMethod {
  return ['cash', 'card_credit', 'card_debit', 'transfer'].includes(method);
}

function normalizeCollectionRequestPayments(dto: {
  method?: string;
  amountCents?: number;
  reference?: string;
  payments?: Array<{ method: string; amountCents: number; reference?: string }>;
}): CollectionPaymentEntry[] {
  const hasLegacy = dto.method !== undefined || dto.amountCents !== undefined;
  const hasArray = dto.payments !== undefined;

  if (hasLegacy && hasArray) {
    throw new BusinessRuleViolationError(
      'AMBIGUOUS_PAYMENT_SHAPE',
      'AMBIGUOUS_PAYMENT_SHAPE',
    );
  }

  if (hasArray) {
    const entries = dto.payments ?? [];
    if (entries.length === 0) {
      throw new BusinessRuleViolationError('EMPTY_PAYMENTS', 'EMPTY_PAYMENTS');
    }

    return entries.map((entry) => {
      if (!isSupportedCollectionMethod(entry.method)) {
        throw new BusinessRuleViolationError(
          'PAYMENT_METHOD_NOT_SUPPORTED',
          'PAYMENT_METHOD_NOT_SUPPORTED',
        );
      }

      return {
        method: entry.method,
        amountCents: entry.amountCents,
        reference: entry.reference,
      };
    });
  }

  if (!dto.method || dto.amountCents === undefined) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  if (!isSupportedCollectionMethod(dto.method)) {
    throw new BusinessRuleViolationError(
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_METHOD_NOT_SUPPORTED',
    );
  }

  return [
    {
      method: dto.method,
      amountCents: dto.amountCents,
      reference: dto.reference,
    },
  ];
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    private readonly productsService: ProductsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly outboxWriter: OutboxWriterService,
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(SALE_COMMENT_REPOSITORY)
    private readonly saleCommentsRepo: Pick<
      ISaleCommentRepository,
      'findActiveBySale'
    > = {
      findActiveBySale: async () => [],
    },
  ) {}

  private async publishSaleConfirmedEvent(input: {
    saleId: string;
    tenantId: string;
    actorId: string;
    folio: string;
    totalCents: number;
    paidCents: number;
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
    confirmedAt: Date;
  }): Promise<void> {
    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.tenantId,
      'Sale',
      input.saleId,
      'sale.confirmed',
      {
        saleId: input.saleId,
        folio: input.folio,
        tenantId: input.tenantId,
        actorId: input.actorId,
        totalCents: input.totalCents,
        paidCents: input.paidCents,
        debtCents: input.debtCents,
        paymentStatus: input.paymentStatus,
        confirmedAt: input.confirmedAt.toISOString(),
      },
    );
  }

  private async publishPaymentReceivedEvents(input: {
    saleId: string;
    tenantId: string;
    actorId: string | null;
    payments: PersistedSalePaymentRecord[];
    paidCents: number;
    debtCents: number;
    occurredAt: Date;
    resultingPaymentStatus?: 'PAID' | 'PARTIAL' | 'CREDIT';
  }): Promise<void> {
    const payments = input.payments ?? [];
    let cumulativePaidCents =
      input.paidCents - payments.reduce((sum, p) => sum + p.amountCents, 0);
    let remainingDebtCents =
      input.paidCents + input.debtCents - cumulativePaidCents;

    for (const payment of payments) {
      cumulativePaidCents += payment.amountCents;
      remainingDebtCents = Math.max(
        remainingDebtCents - payment.amountCents,
        0,
      );

      await this.outboxWriter.publish(
        this.tenantPrisma.getClient(),
        input.tenantId,
        'Sale',
        input.saleId,
        'sale.payment.received',
        {
          saleId: input.saleId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          paymentId: payment.paymentId,
          method: payment.method,
          amountCents: payment.amountCents,
          reference: payment.reference ?? undefined,
          occurredAt: input.occurredAt.toISOString(),
          resultingPaidCents: cumulativePaidCents,
          resultingDebtCents: remainingDebtCents,
          resultingPaymentStatus:
            input.resultingPaymentStatus ??
            (remainingDebtCents === 0 ? 'PAID' : 'PARTIAL'),
        },
      );
    }
  }

  private async publishSaleFullyPaidEvent(input: {
    saleId: string;
    tenantId: string;
    folio: string;
    totalCents: number;
    paidAt: Date;
  }): Promise<void> {
    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.tenantId,
      'Sale',
      input.saleId,
      'sale.fully.paid',
      {
        saleId: input.saleId,
        tenantId: input.tenantId,
        folio: input.folio,
        totalCents: input.totalCents,
        paidAt: input.paidAt.toISOString(),
      },
    );
  }

  // ==================== Use Cases ====================

  /**
   * Open a new draft sale for a user.
   */
  async openDraft(userId: string) {
    const saleId = randomUUID();
    const sale = Sale.create({ id: saleId, userId });

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.draft.opened',
      new SaleDraftOpenedEvent(saleId, userId),
    );

    return sale.toResponse();
  }

  /**
   * Add item to a draft sale.
   * Validates ownership, product/variant, and stock availability.
   * Freezes price at add-time.
   */
  async addItem(saleId: string, userId: string, dto: AddItemDto) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    // Fetch product info and freeze price
    const productInfo = await this.productsService.getProductInfoForSale(
      dto.productId,
      dto.variantId ?? null,
    );

    // Calculate cumulative quantity if stacking same product+variant
    const existingItem = sale.items.find(
      (item) =>
        item.productId === dto.productId &&
        item.variantId === (dto.variantId ?? null),
    );
    const cumulativeQuantity = existingItem
      ? existingItem.quantity + dto.quantity
      : dto.quantity;

    // Check stock availability for cumulative quantity (no reservation)
    const stockCheck = await this.productsService.checkStockAvailability(
      dto.productId,
      dto.variantId ?? null,
      cumulativeQuantity,
    );

    if (!stockCheck.available) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for product ${dto.productId}. ` +
          `Available: ${stockCheck.currentStock}, Requested: ${cumulativeQuantity}`,
      );
    }

    // Add item to sale (stacks if same product+variant)
    const itemId = randomUUID();
    sale.addItem({
      id: itemId,
      saleId,
      productId: productInfo.productId,
      variantId: productInfo.variantId,
      productName: productInfo.productName,
      variantName: productInfo.variantName,
      imageUrl: productInfo.imageUrl,
      quantity: dto.quantity,
      unitPriceCents: productInfo.unitPriceCents,
      unitPriceCurrency: 'MXN',
    });

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.item.added',
      new SaleItemAddedEvent(
        saleId,
        itemId,
        productInfo.productId,
        productInfo.variantId,
        dto.quantity,
        productInfo.unitPriceCents,
      ),
    );

    return sale.toResponse();
  }

  /**
   * Update quantity of an existing item in a draft sale.
   * Validates ownership and stock availability for new quantity.
   */
  async updateItemQuantity(
    saleId: string,
    userId: string,
    itemId: string,
    dto: UpdateItemQuantityDto,
  ) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    // Find the item to get product/variant info
    const item = sale.items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(`Item ${itemId} not found in sale`);
    }

    const previousQuantity = item.quantity;

    // Check stock for new quantity
    const stockCheck = await this.productsService.checkStockAvailability(
      item.productId,
      item.variantId,
      dto.quantity,
    );

    if (!stockCheck.available) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for product ${item.productId}. ` +
          `Available: ${stockCheck.currentStock}, Requested: ${dto.quantity}`,
      );
    }

    // Update quantity
    sale.updateItemQuantity(itemId, dto.quantity);

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.item.quantity.changed',
      new SaleItemQuantityChangedEvent(
        saleId,
        itemId,
        previousQuantity,
        dto.quantity,
      ),
    );

    return sale.toResponse();
  }

  /**
   * Clear all items from a draft sale (idempotent).
   */
  async clearItems(saleId: string, userId: string) {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    const clearedItemCount = sale.items.length;
    sale.clearItems();

    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.cleared',
      new SaleClearedEvent(saleId, clearedItemCount),
    );

    return sale.toResponse();
  }

  async removeItem(saleId: string, actorId: string, itemId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.removeItem(itemId);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.item.removed',
      new SaleItemRemovedEvent(saleId, itemId, actorId, new Date()),
    );

    return sale.toResponse();
  }

  /**
   * Delete a draft sale (hard delete).
   */
  async deleteDraft(saleId: string, userId: string): Promise<void> {
    // Load sale
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new EntityNotFoundError('Sale', saleId);
    }

    // Enforce ownership
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        `User ${userId} does not own this sale`,
      );
    }

    await this.saleRepo.delete(saleId);

    this.eventEmitter.emit(
      'sale.draft.deleted',
      new SaleDraftDeletedEvent(saleId, userId),
    );
  }

  /**
   * Get all draft sales for a user.
   */
  async getUserDrafts(userId: string) {
    const sales = await this.saleRepo.findDraftsByUserId(userId);
    return sales.map((sale) => sale.toResponse());
  }

  /**
   * Search POS catalog (facade to ProductsService).
   * Delegates to ProductsService.searchForPOS.
   */
  async searchPosCatalog(dto: {
    q?: string;
    limit?: number;
    offset?: number;
    categoryId?: string;
    brandId?: string;
  }) {
    return this.productsService.searchForPOS(dto);
  }

  async listSales(query: ListSalesQueryDto): Promise<SaleListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const extendedFilters = this.toSalesListExtendedFilter(query);
    const baseFilters: SalesListBaseFilter = {
      q: extendedFilters.q,
      cashierUserId: extendedFilters.cashierUserId,
      customerId: extendedFilters.customerId,
      customerIncludeNull: extendedFilters.customerIncludeNull,
      confirmedFrom: extendedFilters.confirmedFrom,
      confirmedTo: extendedFilters.confirmedTo,
    };

    const [data, total, groupedPaymentStatus, notDelivered] = await Promise.all(
      [
        this.saleRepo.findManyConfirmed({
          page,
          limit,
          sortBy: query.sortBy ?? 'confirmedAt',
          sortOrder: query.sortOrder ?? 'desc',
          ...extendedFilters,
        }),
        this.saleRepo.countConfirmed(baseFilters),
        this.saleRepo.groupByPaymentStatusConfirmed(baseFilters),
        this.saleRepo.countNotDeliveredConfirmed(baseFilters),
      ],
    );

    const paidCount = groupedPaymentStatus
      .filter((item) => item.paymentStatus === 'PAID')
      .reduce((acc, item) => acc + item._count._all, 0);
    const pendingPayments = Math.max(0, total - paidCount);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data,
      pagination: { page, limit, total, totalPages },
      counts: {
        all: total,
        pendingPayments,
        notDelivered,
      },
    };
  }

  private toSalesListExtendedFilter(
    query: ListSalesQueryDto,
  ): SalesListExtendedFilter {
    return {
      q: query.q,
      folio: query.folio,
      status: query.status,
      paymentStatus: query.paymentStatus,
      deliveryStatus: query.deliveryStatus,
      paymentMethod: query.paymentMethod,
      paymentMethodIncludeNull: query.paymentMethodIncludeNull,
      totalMin: query.totalMin,
      totalMax: query.totalMax,
      debtMin: query.debtMin,
      debtMax: query.debtMax,
      dueDateFrom: query.dueDateFrom,
      dueDateTo: query.dueDateTo,
      dueDateIncludeNull: query.dueDateIncludeNull,
      cashierUserId: query.cashierUserId,
      customerId: query.customerId,
      customerIncludeNull: query.customerIncludeNull,
      confirmedFrom: query.confirmedFrom,
      confirmedTo: query.confirmedTo,
    };
  }

  async getSaleDetail(saleId: string): Promise<SaleDetailResponseDto> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        saleId,
      )
    ) {
      throw new BadRequestException('Validation failed (uuid is expected)');
    }

    const sale = await this.saleRepo.findOneWithRelations(saleId);
    if (!sale) {
      throw new NotFoundException('Sale not found');
    }

    const comments = await this.saleCommentsRepo.findActiveBySale(saleId);

    return {
      id: sale.id,
      folio: sale.folio,
      status: sale.status,
      channel: sale.channel,
      register: sale.register,
      confirmedAt: sale.confirmedAt?.toISOString() ?? null,
      dueDate: sale.dueDate ? sale.dueDate.toISOString() : null,
      subtotalCents: sale.subtotalCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      paidCents: sale.paidCents,
      debtCents: sale.debtCents,
      changeDueCents: sale.changeDueCents,
      paymentStatus: sale.paymentStatus,
      deliveryStatus: sale.deliveryStatus,
      customer: sale.customer,
      cashier: sale.cashier,
      seller: sale.seller,
      items: sale.items,
      payments: sale.payments.map((payment) => ({
        method: payment.method,
        amountCents: payment.amountCents,
        tenderedCents: payment.tenderedCents,
        changeCents: payment.changeCents,
        reference: payment.reference,
        paidAt: payment.paidAt.toISOString(),
      })),
      timeline: buildSaleTimeline({
        createdAt: sale.createdAt,
        confirmedAt: sale.confirmedAt,
        deliveryStatus: sale.deliveryStatus,
        register: sale.register,
        cashier: sale.cashier,
        payments: sale.payments.map((payment) => ({
          method: payment.method,
          amountCents: payment.amountCents,
          reference: payment.reference,
          createdAt: payment.createdAt,
          userId: payment.userId,
          user: payment.user,
        })),
        comments: comments.map((comment) => ({
          id: comment.id,
          createdAt: comment.createdAt,
          body: comment.body,
          author: comment.author,
        })),
      }),
    };
  }

  /**
   * Get single product detail for POS (facade to ProductsService).
   * Delegates to ProductsService.findOneForPOS.
   */
  async getProductDetail(productId: string) {
    const product = await this.productsService.findOneForPOS(productId);
    if (!product) {
      throw new EntityNotFoundError('Product', productId);
    }
    return product;
  }

  async getAvailablePrices(
    saleId: string,
    itemId: string,
    actorId: string,
  ): Promise<AvailablePricesResponseDto> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const item = sale.items.find((i) => i.id === itemId);
    if (!item)
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );

    const prices = await this.productsService.getApplicablePrices(
      item.productId,
      item.variantId,
      item.quantity,
    );

    return {
      saleId,
      itemId,
      prices: prices.map((p) => ({
        ...p,
        currency: 'MXN' as const,
        // Strategy: when item comes from price-list override, current marker is strict by applied list id.
        // Otherwise (default/custom paths with null list id), fallback to matching current unit price.
        isCurrent:
          item.appliedPriceListId !== null
            ? item.appliedPriceListId === p.priceListId
            : item.unitPriceCents === p.priceCents,
      })),
    };
  }

  async overrideItemPrice(
    saleId: string,
    itemId: string,
    dto: OverrideItemPriceDto,
    actorId: string,
  ) {
    if (
      (dto.priceListId && dto.customPriceCents) ||
      (!dto.priceListId && !dto.customPriceCents)
    ) {
      throw new BusinessRuleViolationError('INVALID_PRICE_OVERRIDE_INPUT');
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }
    const item = sale.items.find((i) => i.id === itemId);
    if (!item)
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );

    const previous = item.unitPriceCents;
    if (dto.priceListId) {
      const resolved = await this.productsService.resolveListPrice(
        dto.priceListId,
        item.productId,
        item.variantId,
        item.quantity,
      );
      sale.overrideItemPrice(itemId, {
        priceCents: resolved,
        priceSource: 'price_list',
        appliedPriceListId: dto.priceListId,
        customPriceCents: null,
      });
    } else {
      sale.overrideItemPrice(itemId, {
        priceCents: dto.customPriceCents!,
        priceSource: 'custom',
        appliedPriceListId: null,
        customPriceCents: dto.customPriceCents!,
      });
    }

    await this.saleRepo.save(sale);
    const updated = sale.items.find((i) => i.id === itemId)!;
    this.eventEmitter.emit(
      'sale.item.price.overridden',
      new SaleItemPriceOverriddenEvent(
        saleId,
        itemId,
        actorId,
        previous,
        updated.unitPriceCents,
        updated.priceSource === 'price_list' ? 'price_list' : 'custom',
        updated.appliedPriceListId,
        updated.customPriceCents,
        new Date(),
      ),
    );

    return sale.toResponse();
  }

  async applyItemDiscount(
    saleId: string,
    itemId: string,
    dto: ApplyItemDiscountDto,
    actorId: string,
  ) {
    if (
      (dto.type === 'amount' && dto.amountCents === undefined) ||
      (dto.type === 'percentage' && dto.percent === undefined) ||
      (dto.amountCents !== undefined && dto.percent !== undefined)
    ) {
      throw new BusinessRuleViolationError(
        'INVALID_DISCOUNT_INPUT',
        'INVALID_DISCOUNT_INPUT',
      );
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.applyItemDiscount(itemId, {
      type: dto.type,
      amountCents: dto.amountCents,
      percent: dto.percent,
      discountTitle: dto.title ?? dto.discountTitle,
    });
    await this.saleRepo.save(sale);

    const updated = sale.items.find((i) => i.id === itemId)!;
    this.eventEmitter.emit(
      'sale.item.discount.applied',
      new SaleItemDiscountAppliedEvent(
        saleId,
        itemId,
        actorId,
        updated.discountType!,
        updated.discountValue!,
        updated.discountAmountCents!,
        updated.discountTitle,
        new Date(),
      ),
    );

    return sale.toResponse();
  }

  async removeItemDiscount(saleId: string, itemId: string, actorId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    sale.removeItemDiscount(itemId);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.item.discount.removed',
      new SaleItemDiscountRemovedEvent(saleId, itemId, actorId, new Date()),
    );

    return sale.toResponse();
  }

  async applyGlobalDiscount(
    saleId: string,
    dto: ApplyItemDiscountDto,
    actorId: string,
  ) {
    if (
      (dto.type === 'amount' && dto.amountCents === undefined) ||
      (dto.type === 'percentage' && dto.percent === undefined) ||
      (dto.amountCents !== undefined && dto.percent !== undefined)
    ) {
      throw new BusinessRuleViolationError(
        'INVALID_DISCOUNT_INPUT',
        'INVALID_DISCOUNT_INPUT',
      );
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const result = sale.applyGlobalDiscount({
      type: dto.type,
      amountCents: dto.amountCents,
      percent: dto.percent,
      discountTitle: dto.title ?? dto.discountTitle,
      strategy: dto.strategy,
    });
    await this.saleRepo.save(sale);

    const skippedIds = new Set(result.skippedItems.map((item) => item.itemId));
    for (const item of sale.items) {
      if (
        skippedIds.has(item.id) ||
        !item.discountType ||
        !item.discountValue
      ) {
        continue;
      }

      this.eventEmitter.emit(
        'sale.item.discount.applied',
        new SaleItemDiscountAppliedEvent(
          saleId,
          item.id,
          actorId,
          item.discountType,
          item.discountValue,
          item.discountAmountCents!,
          item.discountTitle,
          new Date(),
        ),
      );
    }

    return {
      sale: result.sale.toResponse(),
      skippedItems: result.skippedItems,
    };
  }

  async removeGlobalDiscount(saleId: string, actorId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== actorId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const discountedItemIds = sale.items
      .filter((item) => item.discountType !== null)
      .map((item) => item.id);

    sale.removeGlobalDiscount();
    await this.saleRepo.save(sale);

    for (const itemId of discountedItemIds) {
      this.eventEmitter.emit(
        'sale.item.discount.removed',
        new SaleItemDiscountRemovedEvent(saleId, itemId, actorId, new Date()),
      );
    }

    return sale.toResponse();
  }

  async assignCustomer(saleId: string, userId: string, dto: AssignCustomerDto) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    const prisma = this.tenantPrisma.getClient();
    const customer = await prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) {
      throw new BusinessRuleViolationError(
        'CUSTOMER_NOT_FOUND',
        'CUSTOMER_NOT_FOUND',
      );
    }

    if (dto.shippingAddressId !== undefined && dto.shippingAddressId !== null) {
      const address = await prisma.customerAddress.findUnique({
        where: { id: dto.shippingAddressId },
      });
      if (!address) {
        throw new BusinessRuleViolationError(
          'SHIPPING_ADDRESS_NOT_FOUND',
          'SHIPPING_ADDRESS_NOT_FOUND',
        );
      }
      if (address.customerId !== dto.customerId) {
        throw new BusinessRuleViolationError(
          'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
          'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
        );
      }
    }

    const previousCustomerId = sale.customerId;
    const previousShippingAddressId = sale.shippingAddressId;
    sale.assignCustomer(dto.customerId, dto.shippingAddressId ?? null);
    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.customer.assigned',
      new SaleCustomerAssignedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousCustomerId,
        sale.customerId!,
        sale.shippingAddressId,
      ),
    );

    if (previousShippingAddressId !== sale.shippingAddressId) {
      if (sale.shippingAddressId) {
        this.eventEmitter.emit(
          'sale.shipping-address.set',
          new SaleShippingAddressSetEvent(
            sale.id,
            this.tenantPrisma.getTenantId() ?? '',
            userId,
            previousShippingAddressId,
            sale.shippingAddressId,
          ),
        );
      } else if (previousShippingAddressId) {
        this.eventEmitter.emit(
          'sale.shipping-address.cleared',
          new SaleShippingAddressClearedEvent(
            sale.id,
            this.tenantPrisma.getTenantId() ?? '',
            userId,
            previousShippingAddressId,
          ),
        );
      }
    }

    return this.saleRepo.findDraftResponseById(sale.id);
  }

  async clearCustomer(saleId: string, userId: string): Promise<void> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    if (!sale.customerId) {
      return;
    }

    const previousCustomerId = sale.customerId;
    const previousShippingAddressId = sale.shippingAddressId;
    sale.clearCustomer();
    await this.saleRepo.save(sale);

    this.eventEmitter.emit(
      'sale.customer.cleared',
      new SaleCustomerClearedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousCustomerId,
        previousShippingAddressId,
      ),
    );

    if (previousShippingAddressId) {
      this.eventEmitter.emit(
        'sale.shipping-address.cleared',
        new SaleShippingAddressClearedEvent(
          sale.id,
          this.tenantPrisma.getTenantId() ?? '',
          userId,
          previousShippingAddressId,
        ),
      );
    }
  }

  async setShippingAddress(
    saleId: string,
    userId: string,
    dto: SetShippingAddressDto,
  ) {
    if (dto.shippingAddressId === null) {
      await this.clearShippingAddress(saleId, userId);
      return this.saleRepo.findDraftResponseById(saleId);
    }

    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }
    if (!sale.customerId) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
      );
    }

    const prisma = this.tenantPrisma.getClient();
    const address = await prisma.customerAddress.findUnique({
      where: { id: dto.shippingAddressId },
    });
    if (!address) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_NOT_FOUND',
        'SHIPPING_ADDRESS_NOT_FOUND',
      );
    }
    if (address.customerId !== sale.customerId) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
        'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
      );
    }

    const previousShippingAddressId = sale.shippingAddressId;
    sale.setShippingAddress(dto.shippingAddressId);
    await this.saleRepo.save(sale);

    if (
      previousShippingAddressId !== sale.shippingAddressId &&
      sale.shippingAddressId
    ) {
      this.eventEmitter.emit(
        'sale.shipping-address.set',
        new SaleShippingAddressSetEvent(
          sale.id,
          this.tenantPrisma.getTenantId() ?? '',
          userId,
          previousShippingAddressId,
          sale.shippingAddressId,
        ),
      );
    }

    return this.saleRepo.findDraftResponseById(sale.id);
  }

  async clearShippingAddress(saleId: string, userId: string): Promise<void> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale)
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    if (sale.status !== 'DRAFT')
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    if (sale.userId !== userId) {
      throw new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      );
    }

    if (!sale.shippingAddressId) {
      return;
    }

    const previousShippingAddressId = sale.shippingAddressId;
    sale.setShippingAddress(null);
    await this.saleRepo.save(sale);
    this.eventEmitter.emit(
      'sale.shipping-address.cleared',
      new SaleShippingAddressClearedEvent(
        sale.id,
        this.tenantPrisma.getTenantId() ?? '',
        userId,
        previousShippingAddressId,
      ),
    );
  }

  async chargeDraft(
    saleId: string,
    actorId: string,
    dto: ChargeSaleDto,
    idempotencyKey: string,
  ) {
    const normalizedPayments = normalizeChargeRequestPayments(dto);
    const hashPayments = sortPaymentsForHash(normalizedPayments);

    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          saleId,
          actorId,
          payments: hashPayments,
          dueDate: dto.dueDate ?? null,
        }),
      )
      .digest('hex');

    const idempotency = await this.saleRepo.acquireChargeIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload as {
        saleId: string;
        folio: string;
        subtotalCents: number;
        discountCents: number;
        totalCents: number;
        paidCents: number;
        debtCents: number;
        changeDueCents: number;
        paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
        confirmedAt: string;
      };
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.userId !== actorId) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.status !== 'DRAFT') {
        throw new BusinessRuleViolationError(
          'SALE_ALREADY_CONFIRMED',
          'SALE_ALREADY_CONFIRMED',
        );
      }

      for (const item of sale.items) {
        if (item.priceSource === 'custom') continue;

        const currentCents =
          item.priceSource === 'price_list' && item.appliedPriceListId
            ? await this.productsService.resolveListPrice(
                item.appliedPriceListId,
                item.productId,
                item.variantId,
                item.quantity,
              )
            : (
                await this.productsService.getProductInfoForSale(
                  item.productId,
                  item.variantId,
                )
              ).unitPriceCents;

        const expectedBaseCents =
          item.prePriceCentsBeforeDiscount ?? item.unitPriceCents;
        if (currentCents !== expectedBaseCents) {
          throw new BusinessRuleViolationError(
            'PRICE_OUT_OF_DATE',
            'PRICE_OUT_OF_DATE',
          );
        }
      }

      const subtotalCents = sale.items.reduce(
        (acc, item) =>
          acc +
          (item.prePriceCentsBeforeDiscount ?? item.unitPriceCents) *
            item.quantity,
        0,
      );
      const totalCents = sale.items.reduce(
        (acc, item) => acc + item.unitPriceCents * item.quantity,
        0,
      );
      const discountCents = subtotalCents - totalCents;

      const tenderedCents = normalizedPayments.reduce(
        (acc, payment) => acc + payment.amountCents,
        0,
      );
      const hasCash = normalizedPayments.some(
        (payment) => payment.method === 'cash',
      );
      const hasCreditMethod = normalizedPayments.some(
        (payment) => payment.method === 'credit',
      );

      if (hasCreditMethod && normalizedPayments.length > 1) {
        chargeValidationError('INVALID_CREDIT_CHARGE');
      }

      if (hasCreditMethod && tenderedCents !== 0) {
        chargeValidationError('INVALID_CREDIT_CHARGE');
      }

      if (!hasCash && tenderedCents > totalCents) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < 0) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < totalCents && !sale.customerId) {
        chargeValidationError('CUSTOMER_REQUIRED_FOR_CREDIT');
      }

      if (
        !hasCreditMethod &&
        tenderedCents < totalCents &&
        tenderedCents <= 0 &&
        normalizedPayments.length > 0
      ) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (tenderedCents < totalCents && tenderedCents > 0 && !hasCash) {
        chargeValidationError('PAYMENT_AMOUNT_INSUFFICIENT');
      }

      const paidCents = Math.min(tenderedCents, totalCents);
      const debtCents = totalCents - paidCents;
      const paymentStatus =
        paidCents === totalCents
          ? 'PAID'
          : paidCents === 0
            ? 'CREDIT'
            : 'PARTIAL';
      const changeDueCents =
        hasCash && paymentStatus === 'PAID' ? tenderedCents - totalCents : 0;

      const canonicalPayments = toCanonicalChargePayments(normalizedPayments);

      const stockAdjustments = sale.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      }));
      // Slice E.3 — capture crossings. The product repository already
      // wrote the durable outbox rows (stock.low.detected) IN THE SAME
      // transaction; the capture here keeps the value visible for any
      // post-commit work (Slice F dispatcher uses the OutboxEvent table,
      // but the returned array lets us assert behavior in spec scenarios).
      await this.productsService.decrementStockForCharge(stockAdjustments);

      const confirmedAt = new Date();
      const folio = await this.saleRepo.allocateNextFolio(confirmedAt);
      const dueDate = resolveDueDate(dto.dueDate, confirmedAt, paymentStatus);
      if (dueDate !== null) {
        sale.setDueDate(dueDate);
      }
      const createdPayments = await this.saleRepo.persistChargeConfirmation({
        saleId,
        userId: actorId,
        payments: canonicalPayments,
        subtotalCents,
        discountCents,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents,
        paymentStatus,
        // Forward draft-level associations explicitly so the confirmation
        // preserves them. Passing `null` for "Público en General" is the
        // intentional empty-customer case, not the destructive default.
        customerId: sale.customerId,
        sellerUserId: sale.sellerUserId,
        dueDate: sale.dueDate,
        confirmedAt,
        folio,
      });

      await this.publishSaleConfirmedEvent({
        saleId,
        tenantId,
        actorId,
        folio,
        totalCents,
        paidCents,
        debtCents,
        paymentStatus,
        confirmedAt,
      });

      await this.publishPaymentReceivedEvents({
        saleId,
        tenantId,
        actorId,
        payments: createdPayments,
        paidCents,
        debtCents,
        occurredAt: confirmedAt,
      });

      if (debtCents === 0) {
        await this.publishSaleFullyPaidEvent({
          saleId,
          tenantId,
          folio,
          totalCents,
          paidAt: confirmedAt,
        });
      }

      const payload = {
        saleId,
        folio,
        subtotalCents,
        discountCents,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents,
        paymentStatus,
        confirmedAt: confirmedAt.toISOString(),
      };

      await this.saleRepo.markChargeIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }

  async cancelSale(
    saleId: string,
    actorId: string,
    dto: CancelSaleDto,
  ): Promise<CancelSaleResult> {
    const idempotencyKey = `sale:cancel:${saleId}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ saleId, actorId, reason: dto.reason }))
      .digest('hex');

    const idempotency = await this.saleRepo.acquireCancellationIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload as CancelSaleResult;
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);

      // Tenant isolation: findByIdForUpdate queries within the tenant-scoped
      // client — a null result means the sale does not belong to this tenant.
      // Authorization: RBAC (delete:Sale / sales:write) is enforced at the
      // controller layer. Creator-ownership is NOT an eligibility gate; any
      // authorized actor in the same tenant may cancel. actorId is still
      // recorded as canceledByUserId for audit purposes.
      if (!sale) {
        throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
      }

      const restockedItems = sale.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      }));

      const buildResult = (
        canceledSale: Sale,
        refundedCents: number,
      ): CancelSaleResult => ({
        saleId: canceledSale.id,
        status: 'CANCELED',
        refundedCents,
        restockedItems,
        canceledAt:
          canceledSale.canceledAt?.toISOString() ?? new Date().toISOString(),
      });

      if (sale.status === 'CANCELED') {
        const replayPayload = buildResult(
          sale,
          sale.paymentStatus === 'CREDIT' || sale.paidCents === 0
            ? 0
            : sale.paidCents,
        );

        await this.saleRepo.markCancellationIdempotencySucceeded(
          idempotency.token,
          saleId,
          replayPayload,
        );

        return replayPayload;
      }

      const { sale: canceledSale, refundedCents } = sale.cancel(dto.reason, {
        actorId,
      });

      await this.productsService.incrementStockForRestock(restockedItems);

      const detail =
        refundedCents === 0
          ? null
          : await this.saleRepo.findOneWithRelations(saleId);
      const refunds =
        refundedCents === 0
          ? []
          : buildCancellationRefunds(
              (detail?.payments ?? []).map((payment) => ({
                paymentId: payment.paymentId,
                method: payment.method,
                amountCents: payment.amountCents,
              })),
              refundedCents,
              dto.reason,
            );

      await this.saleRepo.persistCancellation(canceledSale, refunds);

      const payload = buildResult(canceledSale, refundedCents);

      await this.outboxWriter.publish(
        this.tenantPrisma.getClient(),
        tenantId,
        'Sale',
        saleId,
        'sale.canceled',
        {
          saleId,
          tenantId,
          actorId,
          folio: canceledSale.folio ?? 'N/A',
          reason: dto.reason,
          refundedCents,
          restockedItems,
          canceledAt: payload.canceledAt,
        },
      );

      await this.saleRepo.markCancellationIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }

  async confirmBotSale(
    input: ConfirmBotSaleInput,
  ): Promise<ConfirmBotSaleResult> {
    return this.saleRepo.runInTransaction(async () => {
      for (const item of input.items) {
        const applicablePrices = await this.productsService.getApplicablePrices(
          item.productId,
          item.variantId ?? null,
          item.quantity,
        );

        const hasMatchingLivePrice = applicablePrices.some(
          (candidate) => candidate.priceCents === item.unitPriceCents,
        );

        if (!hasMatchingLivePrice) {
          throw new BusinessRuleViolationError(
            'PRICE_OUT_OF_DATE',
            'PRICE_OUT_OF_DATE',
          );
        }
      }

      const tenantId = this.tenantPrisma.getTenantId();
      const saleId = randomUUID();
      const sale = Sale.create({
        id: saleId,
        userId: input.cashierUserId,
      });

      sale.assignCustomer(input.customerId, input.shippingAddressId ?? null);
      sale.assignSeller(input.cashierUserId);

      for (const item of input.items) {
        sale.addItem({
          id: randomUUID(),
          saleId,
          productId: item.productId,
          variantId: item.variantId ?? null,
          productName: item.productName,
          variantName: item.variantName ?? null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitPriceCurrency: 'MXN',
        });
      }

      await this.saleRepo.save(sale);

      const totalCents = input.items.reduce(
        (sum, item) => sum + item.unitPriceCents * item.quantity,
        0,
      );
      const paidCents = 0 as const;
      const debtCents = totalCents;

      // Slice E.3 — capture crossings. The product repository already
      // wrote the durable outbox rows (stock.low.detected) IN THE SAME
      // transaction; the capture here is observable for spec assertions.
      await this.productsService.decrementStockForCharge(
        input.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
        })),
      );

      const confirmedAt = new Date();
      const folio = await this.saleRepo.allocateNextFolio(confirmedAt);
      const dueDate = resolveDueDate(undefined, confirmedAt, 'CREDIT');

      await this.saleRepo.persistChargeConfirmation({
        saleId,
        userId: input.cashierUserId,
        payments: [],
        subtotalCents: totalCents,
        discountCents: 0,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents: 0,
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        customerId: input.customerId,
        sellerUserId: input.cashierUserId,
        dueDate,
        confirmedAt,
        folio,
      });

      await this.publishSaleConfirmedEvent({
        saleId,
        tenantId,
        actorId: input.cashierUserId,
        folio,
        totalCents,
        paidCents,
        debtCents,
        paymentStatus: 'CREDIT',
        confirmedAt,
      });

      return {
        saleId,
        folio,
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents,
        paidCents,
        debtCents,
        confirmedAt: confirmedAt.toISOString(),
      };
    });
  }

  async setDueDate(
    saleId: string,
    dto: UpdateSaleDueDateDto,
  ): Promise<SaleDetailResponseDto> {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale || sale.status !== 'CONFIRMED') {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const detail = await this.saleRepo.findOneWithRelations(saleId);
    if (!detail) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    if (detail.paymentStatus === 'PAID') {
      throw new SaleFullyPaidError();
    }

    if (dto.dueDate !== null && dto.dueDate !== undefined) {
      const requestedDate = new Date(dto.dueDate);
      const todayStartOfDayUtc = new Date();
      todayStartOfDayUtc.setUTCHours(0, 0, 0, 0);

      const requestedStartOfDayUtc = new Date(requestedDate);
      requestedStartOfDayUtc.setUTCHours(0, 0, 0, 0);

      if (requestedStartOfDayUtc < todayStartOfDayUtc) {
        throw new InvalidDueDateError();
      }
    }

    sale.setDueDate(dto.dueDate ? new Date(dto.dueDate) : null);
    await this.saleRepo.save(sale);

    return this.getSaleDetail(saleId);
  }

  async assignSeller(
    saleId: string,
    actorUserId: string,
    dto: AssignSellerDto,
  ) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const seller = await this.tenantPrisma
      .getClient()
      .user.findUnique({ where: { id: dto.sellerUserId } });

    if (!seller) {
      throw new SellerNotFoundError();
    }

    const previousSellerUserId = sale.sellerUserId;
    sale.assignSeller(dto.sellerUserId);
    await this.saleRepo.save(sale);

    if (previousSellerUserId !== dto.sellerUserId) {
      this.eventEmitter.emit('sale.seller.assigned', {
        saleId: sale.id,
        tenantId: this.tenantPrisma.getTenantId() ?? '',
        userId: actorUserId,
        previousSellerUserId,
        sellerUserId: dto.sellerUserId,
      });
    }

    if (sale.status === 'DRAFT') {
      return this.saleRepo.findDraftResponseById(sale.id);
    }

    return this.getSaleDetail(sale.id);
  }

  async clearSeller(saleId: string, actorUserId: string) {
    const sale = await this.saleRepo.findById(saleId);
    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }

    const previousSellerUserId = sale.sellerUserId;
    sale.clearSeller();
    await this.saleRepo.save(sale);

    if (previousSellerUserId !== null) {
      this.eventEmitter.emit('sale.seller.cleared', {
        saleId: sale.id,
        tenantId: this.tenantPrisma.getTenantId() ?? '',
        userId: actorUserId,
        previousSellerUserId,
      });
    }

    if (sale.status === 'DRAFT') {
      return this.saleRepo.findDraftResponseById(sale.id);
    }

    return this.getSaleDetail(sale.id);
  }

  async addPayment(
    saleId: string,
    actorId: string,
    dto: {
      method?: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
      amountCents?: number;
      reference?: string;
      payments?: Array<{
        method: 'cash' | 'card_credit' | 'card_debit' | 'transfer' | 'credit';
        amountCents: number;
        reference?: string;
      }>;
    },
    idempotencyKey: string,
    authMode: AddPaymentAuthMode = 'owner',
  ) {
    const normalizedPayments = normalizeCollectionRequestPayments(dto);
    const hashPayments = sortPaymentsForHash(
      normalizedPayments.map((payment) => ({
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference,
      })),
    );

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ saleId, actorId, payments: hashPayments }))
      .digest('hex');

    const idempotency = await this.saleRepo.acquirePaymentIdempotency(
      saleId,
      idempotencyKey,
      requestHash,
    );
    if (idempotency.kind === 'replay') {
      return idempotency.payload;
    }
    if (idempotency.kind === 'conflict') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    }
    if (idempotency.kind === 'in_flight') {
      throw new BusinessRuleViolationError(
        'IDEMPOTENCY_KEY_IN_FLIGHT',
        'IDEMPOTENCY_KEY_IN_FLIGHT',
      );
    }

    return this.saleRepo.runInTransaction(async () => {
      const tenantId = this.tenantPrisma.getTenantId();
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale || (authMode === 'owner' && sale.userId !== actorId)) {
        throw new BusinessRuleViolationError(
          'SALE_NOT_FOUND',
          'SALE_NOT_FOUND',
        );
      }
      if (sale.status !== 'CONFIRMED') {
        throw new BusinessRuleViolationError(
          'SALE_NOT_CONFIRMABLE_FOR_PAYMENT',
          'SALE_NOT_CONFIRMABLE_FOR_PAYMENT',
        );
      }
      const paymentsToPersist =
        authMode === 'reviewer'
          ? normalizedPayments.map((payment) => ({
              ...payment,
              method: 'transfer' as const,
              metadataJson: {
                origin: { kind: 'bot', channel: sale.channel },
              },
            }))
          : normalizedPayments;

      const updated = await this.saleRepo.persistCollectedPayments({
        saleId,
        userId: authMode === 'reviewer' ? null : actorId,
        payments: paymentsToPersist,
      });

      const eventPayments = paymentsToPersist.map((payment, index) => ({
        paymentId: updated.paymentIds[index],
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference ?? null,
      }));

      await this.publishPaymentReceivedEvents({
        saleId,
        tenantId,
        actorId: authMode === 'reviewer' ? null : actorId,
        payments: eventPayments,
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        occurredAt: new Date(),
        resultingPaymentStatus: updated.paymentStatus,
      });

      if (updated.debtCents === 0) {
        await this.publishSaleFullyPaidEvent({
          saleId,
          tenantId,
          folio: sale.folio ?? 'N/A',
          totalCents: updated.totalCents,
          paidAt: new Date(),
        });
      }

      const payload = {
        saleId,
        paidCents: updated.paidCents,
        debtCents: updated.debtCents,
        totalCents: updated.totalCents,
        paymentStatus: updated.paymentStatus,
        paymentIds: updated.paymentIds,
      };

      await this.saleRepo.markPaymentIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );

      return payload;
    });
  }
}
