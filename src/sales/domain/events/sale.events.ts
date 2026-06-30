/**
 * Domain Events for Sales (POS).
 * Past tense: something that already happened.
 */

export class SaleDraftOpenedEvent {
  constructor(
    public readonly saleId: string,
    public readonly userId: string,
  ) {}
}

export class SaleItemAddedEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly productId: string,
    public readonly variantId: string | null,
    public readonly quantity: number,
    public readonly unitPriceCents: number,
  ) {}
}

export class SaleItemQuantityChangedEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly previousQuantity: number,
    public readonly newQuantity: number,
  ) {}
}

export class SaleClearedEvent {
  constructor(
    public readonly saleId: string,
    public readonly clearedItemCount: number,
  ) {}
}

export class SaleDraftDeletedEvent {
  constructor(
    public readonly saleId: string,
    public readonly userId: string,
  ) {}
}

export class SaleItemPriceOverriddenEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly actorId: string,
    public readonly previousUnitPriceCents: number,
    public readonly newUnitPriceCents: number,
    public readonly priceSource: 'price_list' | 'custom',
    public readonly appliedPriceListId: string | null,
    public readonly customPriceCents: number | null,
    public readonly occurredAt: Date,
  ) {}
}

export class SaleItemDiscountAppliedEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly actorId: string,
    public readonly discountType: 'amount' | 'percentage',
    public readonly discountValue: number,
    public readonly discountAmountCents: number,
    public readonly discountTitle: string | null,
    public readonly occurredAt: Date,
  ) {}
}

export class SaleItemDiscountRemovedEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly actorId: string,
    public readonly occurredAt: Date,
  ) {}
}

export class SaleItemRemovedEvent {
  constructor(
    public readonly saleId: string,
    public readonly itemId: string,
    public readonly actorId: string,
    public readonly occurredAt: Date,
  ) {}
}

export class SaleCustomerAssignedEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly previousCustomerId: string | null,
    public readonly customerId: string,
    public readonly shippingAddressId: string | null,
  ) {}
}

export class SaleCustomerClearedEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly previousCustomerId: string,
    public readonly previousShippingAddressId: string | null,
  ) {}
}

export class SaleShippingAddressSetEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly previousShippingAddressId: string | null,
    public readonly shippingAddressId: string,
  ) {}
}

export class SaleShippingAddressClearedEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly previousShippingAddressId: string,
  ) {}
}

export class SaleConfirmedEvent {
  constructor(
    public readonly saleId: string,
    public readonly folio: string,
    public readonly tenantId: string,
    public readonly actorId: string,
    public readonly totalCents: number,
    public readonly paidCents: number,
    public readonly debtCents: number,
    public readonly paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT',
    public readonly confirmedAt: string,
  ) {}
}

export class SalePaymentReceivedEvent {
  constructor(
    public readonly saleId: string,
    public readonly paymentId: string,
    public readonly tenantId: string,
    public readonly actorId: string | null,
    public readonly method: 'cash' | 'card_credit' | 'card_debit' | 'transfer',
    public readonly amountCents: number,
    public readonly reference: string | undefined,
    public readonly occurredAt: string,
    public readonly resultingPaidCents: number,
    public readonly resultingDebtCents: number,
    public readonly resultingPaymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT',
  ) {}
}

export class SaleFullyPaidEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly folio: string,
    public readonly totalCents: number,
    public readonly paidAt: string,
  ) {}
}

export class SaleCanceledEvent {
  constructor(
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly actorId: string,
    public readonly folio: string,
    public readonly reason:
      | 'CUSTOMER_REQUEST'
      | 'ORDER_ERROR'
      | 'OUT_OF_STOCK'
      | 'DUPLICATE_SALE'
      | 'OTHER',
    public readonly refundedCents: number,
    public readonly restockedItems: Array<{
      productId: string;
      variantId: string | null;
      quantity: number;
    }>,
    public readonly canceledAt: string,
  ) {}
}

export class ReceiptConfirmedEvent {
  constructor(
    public readonly receiptId: string,
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly amountCents: number,
    public readonly paymentMethod: 'TRANSFER',
    public readonly origin: { kind: 'bot'; channel: 'ONLINE' | 'POS' },
    public readonly validatedByUserId: string,
    public readonly validatedAt: string,
    public readonly resultingPaymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT',
    public readonly occurredAt: string,
  ) {}
}

export class ReceiptRejectedEvent {
  constructor(
    public readonly receiptId: string,
    public readonly saleId: string,
    public readonly tenantId: string,
    public readonly validatedByUserId: string,
    public readonly reason: string,
    public readonly occurredAt: string,
  ) {}
}
