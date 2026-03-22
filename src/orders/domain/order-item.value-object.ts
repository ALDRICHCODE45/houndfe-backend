/**
 * VALUE OBJECT: OrderItem
 *
 * Immutable line item in an order.
 * Defined by its attributes (no identity of its own).
 */
import {
  Money,
  Currency,
} from '../../shared/domain/value-objects/money.value-object';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export class OrderItem {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly subtotal: Money;

  private constructor(
    productId: string,
    productName: string,
    quantity: number,
    unitPrice: Money,
  ) {
    this.productId = productId;
    this.productName = productName;
    this.quantity = quantity;
    this.unitPrice = unitPrice;
    this.subtotal = unitPrice.multiply(quantity);
  }

  static create(
    productId: string,
    productName: string,
    quantity: number,
    unitPrice: Money,
  ): OrderItem {
    if (!productId) throw new InvalidArgumentError('Product ID is required');
    if (!productName)
      throw new InvalidArgumentError('Product name is required');
    if (quantity <= 0)
      throw new InvalidArgumentError('Quantity must be positive');
    if (unitPrice.isZero())
      throw new InvalidArgumentError('Unit price cannot be zero');

    return new OrderItem(productId, productName, quantity, unitPrice);
  }

  static fromPersistence(data: {
    productId: string;
    productName: string;
    quantity: number;
    unitPriceAmount: number;
    unitPriceCurrency: Currency;
  }): OrderItem {
    return new OrderItem(
      data.productId,
      data.productName,
      data.quantity,
      Money.fromDecimal(data.unitPriceAmount, data.unitPriceCurrency),
    );
  }

  static sumSubtotals(items: OrderItem[]): Money {
    if (items.length === 0) return Money.zero('USD');
    return items.reduce(
      (sum, item) => sum.add(item.subtotal),
      Money.zero(items[0].unitPrice.currency),
    );
  }

  equals(other: OrderItem): boolean {
    return (
      this.productId === other.productId &&
      this.quantity === other.quantity &&
      this.unitPrice.equals(other.unitPrice)
    );
  }

  toJSON() {
    return {
      productId: this.productId,
      productName: this.productName,
      quantity: this.quantity,
      unitPrice: this.unitPrice.toJSON(),
      subtotal: this.subtotal.toJSON(),
    };
  }
}
