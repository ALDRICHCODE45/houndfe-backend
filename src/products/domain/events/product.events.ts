/**
 * Domain Events for Products.
 *
 * These are plain classes (no NestJS decorators).
 * NestJS EventEmitter dispatches them; listeners react.
 *
 * Naming convention: past tense (something that already happened).
 *
 * NOTE: Events are not emitted in this CRUD-first iteration.
 * Kept for backward compatibility with listener registrations.
 */

export class ProductCreatedEvent {
  constructor(
    public readonly productId: string,
    public readonly name: string,
    public readonly sku: string | null,
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
