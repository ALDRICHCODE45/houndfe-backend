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
