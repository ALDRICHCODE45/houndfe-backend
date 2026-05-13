/**
 * SalesService - Application layer (Use Cases) for POS Sales.
 *
 * Orchestrates domain logic and infrastructure for the Sale aggregate.
 * Handles: draft creation, item management, validation, and ownership enforcement.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'crypto';
import { Sale } from './domain/sale.entity';
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
} from './domain/events/sale.events';
import type { AddItemDto } from './dto/add-item.dto';
import type { UpdateItemQuantityDto } from './dto/update-item-quantity.dto';
import type { OverrideItemPriceDto } from './dto/override-item-price.dto';
import type { AvailablePricesResponseDto } from './dto/available-prices-response.dto';
import type { ApplyItemDiscountDto } from './dto/apply-item-discount.dto';
import type { ChargeSaleDto } from './dto/charge-sale.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import type { SaleListResponseDto } from './dto/sale-list-response.dto';
import type { SaleDetailResponseDto } from './dto/sale-detail-response.dto';
import { buildSaleTimeline } from './domain/build-sale-timeline';

type SupportedChargeMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer'
  | 'credit';

function isSupportedChargeMethod(
  method: ChargeSaleDto['method'],
): method is SupportedChargeMethod {
  return ['cash', 'card_credit', 'card_debit', 'transfer', 'credit'].includes(
    method,
  );
}

function chargeValidationError(
  code: 'INVALID_CREDIT_CHARGE' | 'CUSTOMER_REQUIRED_FOR_CREDIT' | 'PAYMENT_AMOUNT_INVALID' | 'PAYMENT_AMOUNT_INSUFFICIENT',
): never {
  throw new BusinessRuleViolationError(code, code);
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly saleRepo: ISaleRepository,
    private readonly productsService: ProductsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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

    const baseFilters = {
      q: query.q,
      from: query.from,
      to: query.to,
      cashierUserId: query.cashierUserId,
      customerId: query.customerId,
    };

    const [data, total, groupedPaymentStatus, notDelivered] = await Promise.all([
      this.saleRepo.findManyConfirmed({
        page,
        limit,
        sortBy: query.sortBy ?? 'confirmedAt',
        sortOrder: query.sortOrder ?? 'desc',
        q: query.q,
        status: query.status,
        paymentStatus: query.paymentStatus,
        deliveryStatus: query.deliveryStatus,
        from: query.from,
        to: query.to,
        cashierUserId: query.cashierUserId,
        customerId: query.customerId,
      }),
      this.saleRepo.countConfirmed(baseFilters),
      this.saleRepo.groupByPaymentStatusConfirmed(baseFilters),
      this.saleRepo.countNotDeliveredConfirmed(baseFilters),
    ]);

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

  async getSaleDetail(saleId: string): Promise<SaleDetailResponseDto> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saleId)) {
      throw new BadRequestException('Validation failed (uuid is expected)');
    }

    const sale = await this.saleRepo.findOneWithRelations(saleId);
    if (!sale) {
      throw new NotFoundException('Sale not found');
    }

    return {
      id: sale.id,
      folio: sale.folio,
      status: sale.status,
      channel: sale.channel,
      register: sale.register,
      confirmedAt: sale.confirmedAt?.toISOString() ?? null,
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
        payments: sale.payments.map((payment) => ({ createdAt: payment.createdAt })),
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
      if (skippedIds.has(item.id) || !item.discountType || !item.discountValue) {
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

  async chargeDraft(
    saleId: string,
    actorId: string,
    dto: ChargeSaleDto,
    idempotencyKey: string,
  ) {
    if (!isSupportedChargeMethod(dto.method)) {
      throw new BusinessRuleViolationError(
        'PAYMENT_METHOD_NOT_SUPPORTED',
        'PAYMENT_METHOD_NOT_SUPPORTED',
      );
    }
    const paymentMethod: SupportedChargeMethod = dto.method;

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ saleId, actorId, dto }))
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
      const sale = await this.saleRepo.findByIdForUpdate(saleId);
      if (!sale) {
        throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
      }
      if (sale.userId !== actorId) {
        throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
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

        if (currentCents !== item.unitPriceCents) {
          throw new BusinessRuleViolationError(
            'PRICE_OUT_OF_DATE',
            'PRICE_OUT_OF_DATE',
          );
        }
      }

      const subtotalCents = sale.items.reduce(
        (acc, item) =>
          acc + (item.originalPriceCents ?? item.unitPriceCents) * item.quantity,
        0,
      );
      const totalCents = sale.items.reduce(
        (acc, item) => acc + item.unitPriceCents * item.quantity,
        0,
      );
      const discountCents = subtotalCents - totalCents;

      const isCash = dto.method === 'cash';
      const isCreditMethod = dto.method === 'credit';

      if (isCreditMethod && dto.amountCents !== 0) {
        chargeValidationError('INVALID_CREDIT_CHARGE');
      }

      if (!isCreditMethod && dto.amountCents > totalCents && !isCash) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (!isCreditMethod && dto.amountCents < 0) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (!isCreditMethod && dto.amountCents < totalCents && !sale.customerId) {
        chargeValidationError('CUSTOMER_REQUIRED_FOR_CREDIT');
      }

      if (isCreditMethod && !sale.customerId) {
        chargeValidationError('CUSTOMER_REQUIRED_FOR_CREDIT');
      }

      if (!isCreditMethod && dto.amountCents < totalCents && dto.amountCents <= 0) {
        chargeValidationError('PAYMENT_AMOUNT_INVALID');
      }

      if (!isCreditMethod && dto.amountCents < totalCents && !isCash) {
        chargeValidationError('PAYMENT_AMOUNT_INSUFFICIENT');
      }

      const paidCents = isCreditMethod ? 0 : Math.min(dto.amountCents, totalCents);
      const debtCents = totalCents - paidCents;
      const paymentStatus =
        paidCents === totalCents
          ? 'PAID'
          : paidCents === 0
            ? 'CREDIT'
            : 'PARTIAL';
      const changeDueCents =
        isCash && paymentStatus === 'PAID' ? dto.amountCents - totalCents : 0;

      const stockAdjustments = sale.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      }));
      await this.productsService.decrementStockForCharge(stockAdjustments);

      const confirmedAt = new Date();
      const folio = await this.saleRepo.allocateNextFolio(confirmedAt);
      await this.saleRepo.persistChargeConfirmation({
        saleId,
        method: paymentMethod,
        amountCents: dto.amountCents,
        subtotalCents,
        discountCents,
        totalCents,
        paidCents,
        debtCents,
        changeDueCents,
        paymentStatus,
        confirmedAt,
        folio,
      });

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
}
