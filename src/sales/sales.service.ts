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
} from './domain/events/sale.events';
import type { AddItemDto } from './dto/add-item.dto';
import type { UpdateItemQuantityDto } from './dto/update-item-quantity.dto';

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
}
