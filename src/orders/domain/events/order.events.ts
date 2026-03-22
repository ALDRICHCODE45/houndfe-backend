/**
 * Domain Events for Orders.
 * Past tense: something that already happened.
 */
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerName: string,
    public readonly itemCount: number,
    public readonly totalAmount: number,
    public readonly totalCurrency: string,
  ) {}
}

export class OrderCompletedEvent {
  constructor(
    public readonly orderId: string,
    public readonly completedAt: Date,
  ) {}
}

export class OrderCancelledEvent {
  constructor(
    public readonly orderId: string,
    public readonly previousStatus: string,
    public readonly productItems: { productId: string; quantity: number }[],
  ) {}
}
