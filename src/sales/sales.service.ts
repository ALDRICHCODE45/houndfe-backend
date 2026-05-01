/**
 * SalesService - Application layer (Use Cases) for POS Sales.
 *
 * Orchestrates domain logic and infrastructure for the Sale aggregate.
 * Handles: draft creation, item management, validation, and ownership enforcement.
 */
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
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
}
