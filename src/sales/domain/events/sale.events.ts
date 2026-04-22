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
