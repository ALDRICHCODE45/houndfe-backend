import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  SaleItemDiscountAppliedEvent,
  SaleItemDiscountRemovedEvent,
  SaleConfirmedEvent,
  SaleFullyPaidEvent,
  SalePaymentReceivedEvent,
  SaleItemPriceOverriddenEvent,
  SaleItemRemovedEvent,
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressSetEvent,
  SaleShippingAddressClearedEvent,
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

  @OnEvent('sale.confirmed')
  onSaleConfirmed(event: SaleConfirmedEvent) {
    this.logger.log({
      eventType: 'sale.confirmed',
      saleId: event.saleId,
      tenantId: event.tenantId,
      folio: event.folio,
    });
  }

  @OnEvent('sale.payment.received')
  onSalePaymentReceived(event: SalePaymentReceivedEvent) {
    this.logger.log({
      eventType: 'sale.payment.received',
      saleId: event.saleId,
      tenantId: event.tenantId,
      paymentId: event.paymentId,
      amountCents: event.amountCents,
    });
  }

  @OnEvent('sale.fully.paid')
  onSaleFullyPaid(event: SaleFullyPaidEvent) {
    this.logger.log({
      eventType: 'sale.fully.paid',
      saleId: event.saleId,
      tenantId: event.tenantId,
      folio: event.folio,
    });
  }

  @OnEvent('sale.customer.assigned')
  onSaleCustomerAssigned(event: SaleCustomerAssignedEvent) {
    this.logger.log({
      eventType: 'sale.customer.assigned',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      customerId: event.customerId,
      previousCustomerId: event.previousCustomerId,
    });
  }

  @OnEvent('sale.customer.cleared')
  onSaleCustomerCleared(event: SaleCustomerClearedEvent) {
    this.logger.log({
      eventType: 'sale.customer.cleared',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      previousCustomerId: event.previousCustomerId,
    });
  }

  @OnEvent('sale.shipping-address.set')
  onSaleShippingAddressSet(event: SaleShippingAddressSetEvent) {
    this.logger.log({
      eventType: 'sale.shipping-address.set',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      shippingAddressId: event.shippingAddressId,
      previousShippingAddressId: event.previousShippingAddressId,
    });
  }

  @OnEvent('sale.shipping-address.cleared')
  onSaleShippingAddressCleared(event: SaleShippingAddressClearedEvent) {
    this.logger.log({
      eventType: 'sale.shipping-address.cleared',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      previousShippingAddressId: event.previousShippingAddressId,
    });
  }

  @OnEvent('sale.seller.assigned')
  onSaleSellerAssigned(event: {
    saleId: string;
    tenantId: string;
    userId: string;
    previousSellerUserId: string | null;
    sellerUserId: string;
  }) {
    this.logger.log({
      eventType: 'sale.seller.assigned',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      previousSellerUserId: event.previousSellerUserId,
      sellerUserId: event.sellerUserId,
    });
  }

  @OnEvent('sale.seller.cleared')
  onSaleSellerCleared(event: {
    saleId: string;
    tenantId: string;
    userId: string;
    previousSellerUserId: string;
  }) {
    this.logger.log({
      eventType: 'sale.seller.cleared',
      saleId: event.saleId,
      tenantId: event.tenantId,
      userId: event.userId,
      previousSellerUserId: event.previousSellerUserId,
    });
  }
}
