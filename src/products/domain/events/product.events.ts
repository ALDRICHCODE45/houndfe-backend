/**
 * Domain Events for Products.
 *
 * These are plain classes (no NestJS decorators).
 * NestJS EventEmitter dispatches them; listeners react.
 *
 * Naming convention: past tense (something that already happened).
 */

export class ProductCreatedEvent {
  constructor(
    public readonly productId: string,
    public readonly name: string,
    public readonly sku: string,
    public readonly stock: number,
  ) {}
}

export class ProductStockDepletedEvent {
  constructor(
    public readonly productId: string,
    public readonly name: string,
  ) {}
}

export class ProductStockLowEvent {
  constructor(
    public readonly productId: string,
    public readonly name: string,
    public readonly currentStock: number,
    public readonly threshold: number,
  ) {}
}
