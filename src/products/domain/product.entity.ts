/**
 * ENTITY: Product (Aggregate Root)
 *
 * Pure domain logic. No framework dependencies.
 *
 * WHY Entity: Has unique identity (id) that persists over time.
 * WHY Aggregate Root: External world only references Product directly.
 *
 * BUSINESS RULES:
 * - Stock cannot go negative
 * - SKU must be uppercase
 * - Price uses Money value object (no floating-point issues)
 */
import {
  Money,
  Currency,
} from '../../shared/domain/value-objects/money.value-object';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { ProductName } from './value-objects/productName.value-object';

export class Product {
  public readonly id: string;
  public name: ProductName;
  public price: Money;
  public readonly sku: string;
  public stock: number;
  public readonly createdAt: Date;
  public updatedAt: Date;

  private constructor(
    id: string,
    name: ProductName,
    price: Money,
    sku: string,
    stock: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.name = name;
    this.price = price;
    this.sku = sku;
    this.stock = stock;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  /** Factory: creates a NEW product with domain validation. */
  static create(
    id: string,
    name: ProductName,
    price: Money,
    sku: string,
    stock = 0,
  ): Product {
    if (!sku?.trim()) throw new InvalidArgumentError('Product SKU is required');
    if (stock < 0) throw new InvalidArgumentError('Stock cannot be negative');

    const now = new Date();
    return new Product(
      id,
      name,
      price,
      sku.trim().toUpperCase(),
      stock,
      now,
      now,
    );
  }

  /** Factory: reconstructs from DB (skips validation — data is already valid). */
  static fromPersistence(data: {
    id: string;
    name: string;
    priceAmount: number;
    priceCurrency: Currency;
    sku: string;
    stock: number;
    createdAt: Date;
    updatedAt: Date;
  }): Product {
    return new Product(
      data.id,
      ProductName.fromPersistence({ name: data.name }),
      Money.fromDecimal(data.priceAmount, data.priceCurrency),
      data.sku,
      data.stock,
      new Date(data.createdAt),
      new Date(data.updatedAt),
    );
  }

  // ==================== Behavior ====================

  decreaseStock(quantity: number): void {
    if (quantity <= 0)
      throw new InvalidArgumentError('Quantity must be positive');
    if (this.stock < quantity) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for "${this.name.productName}". Available: ${this.stock}, requested: ${quantity}`,
        'INSUFFICIENT_STOCK',
      );
    }
    this.stock -= quantity;
    this.updatedAt = new Date();
  }

  increaseStock(quantity: number): void {
    if (quantity <= 0)
      throw new InvalidArgumentError('Quantity must be positive');
    this.stock += quantity;
    this.updatedAt = new Date();
  }

  updatePrice(newPrice: Money): void {
    this.price = newPrice;
    this.updatedAt = new Date();
  }

  updateName(newName: ProductName) {
    this.name = newName;
    this.updatedAt = new Date();
  }

  canSell(quantity: number): boolean {
    return this.stock >= quantity && quantity > 0;
  }

  isOutOfStock(): boolean {
    return this.stock === 0;
  }

  // ==================== Serialization ====================

  toResponse() {
    return {
      id: this.id,
      name: this.name.productName,
      price: this.price.toJSON(),
      sku: this.sku,
      stock: this.stock,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  toPersistence() {
    return {
      id: this.id,
      name: this.name.productName,
      price: Math.round(this.price.amount * 100), // store as cents
      currency: this.price.currency,
      sku: this.sku,
      stock: this.stock,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
