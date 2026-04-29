import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  SaleItemDiscountAppliedEvent,
  SaleItemDiscountRemovedEvent,
  SaleItemPriceOverriddenEvent,
  SaleItemRemovedEvent,
} from '../domain/events/sale.events';

@Injectable()
export class SaleEventListener {
  private readonly logger = new Logger(SaleEventListener.name);

  @OnEvent('sale.item.price.overridden')
  onSaleItemPriceOverridden(event: SaleItemPriceOverriddenEvent) {
    this.logger.log({
      type: 'sale.item.price.overridden',
      saleId: event.saleId,
      itemId: event.itemId,
      actorId: event.actorId,
      previousUnitPriceCents: event.previousUnitPriceCents,
      newUnitPriceCents: event.newUnitPriceCents,
      priceSource: event.priceSource,
      appliedPriceListId: event.appliedPriceListId,
      customPriceCents: event.customPriceCents,
      occurredAt: event.occurredAt,
    });
  }

  @OnEvent('sale.item.discount.applied')
  onSaleItemDiscountApplied(event: SaleItemDiscountAppliedEvent) {
    this.logger.log({
      type: 'sale.item.discount.applied',
      saleId: event.saleId,
      itemId: event.itemId,
      actorId: event.actorId,
      discountType: event.discountType,
      discountValue: event.discountValue,
      discountAmountCents: event.discountAmountCents,
      discountTitle: event.discountTitle,
      occurredAt: event.occurredAt,
    });
  }

  @OnEvent('sale.item.discount.removed')
  onSaleItemDiscountRemoved(event: SaleItemDiscountRemovedEvent) {
    this.logger.log({
      type: 'sale.item.discount.removed',
      saleId: event.saleId,
      itemId: event.itemId,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
    });
  }

  @OnEvent('sale.item.removed')
  onSaleItemRemoved(event: SaleItemRemovedEvent) {
    this.logger.log({
      type: 'sale.item.removed',
      saleId: event.saleId,
      itemId: event.itemId,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
    });
  }
}
