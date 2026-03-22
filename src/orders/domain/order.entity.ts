/**
 * ENTITY: Order (Aggregate Root)
 *
 * Pure domain logic for POS orders.
 *
 * STATE MACHINE:
 *   DRAFT → PLACED → PAID → COMPLETED
 *                      ↓
 *                   CANCELLED
 *
 * Order does NOT call ProductRepository directly.
 * The service layer coordinates between aggregates.
 */
import { Money } from '../../shared/domain/value-objects/money.value-object';
import { OrderItem } from './order-item.value-object';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';

export enum OrderStatus {
  DRAFT = 'DRAFT',
  PLACED = 'PLACED',
  PAID = 'PAID',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export class Order {
  public readonly id: string;
  public readonly customerName: string;
  public readonly items: OrderItem[] = [];
  public status: OrderStatus;
  public readonly createdAt: Date;
  public completedAt: Date | null = null;

  private constructor(
    id: string,
    customerName: string,
    status: OrderStatus,
    createdAt: Date,
  ) {
    this.id = id;
    this.customerName = customerName;
    this.status = status;
    this.createdAt = createdAt;
  }

  static create(id: string, customerName: string): Order {
    if (!customerName?.trim())
      throw new InvalidArgumentError('Customer name is required');
    return new Order(id, customerName.trim(), OrderStatus.DRAFT, new Date());
  }

  static fromPersistence(data: {
    id: string;
    customerName: string;
    status: string;
    items: OrderItem[];
    createdAt: Date;
    completedAt: Date | null;
  }): Order {
    const order = new Order(
      data.id,
      data.customerName,
      data.status as OrderStatus,
      new Date(data.createdAt),
    );
    order.items.push(...data.items);
    order.completedAt = data.completedAt ? new Date(data.completedAt) : null;
    return order;
  }

  // ==================== Computed ====================

  get subtotal(): Money {
    return OrderItem.sumSubtotals(this.items);
  }
  get tax(): Money {
    return this.subtotal.multiply(0.1);
  }
  get total(): Money {
    return this.subtotal.add(this.tax);
  }

  // ==================== Behavior ====================

  addItem(item: OrderItem): void {
    this.ensureStatus(OrderStatus.DRAFT, 'Cannot modify a non-draft order');
    const exists = this.items.some((i) => i.productId === item.productId);
    if (exists)
      throw new BusinessRuleViolationError(
        'Product already in order',
        'DUPLICATE_ITEM',
      );
    this.items.push(item);
  }

  removeItem(productId: string): void {
    this.ensureStatus(OrderStatus.DRAFT, 'Cannot modify a non-draft order');
    const idx = this.items.findIndex((i) => i.productId === productId);
    if (idx < 0) throw new InvalidArgumentError('Product not found in order');
    this.items.splice(idx, 1);
  }

  /** Confirms the order. After this, items cannot be modified. */
  place(): void {
    this.ensureStatus(OrderStatus.DRAFT, 'Order must be DRAFT to place');
    if (this.items.length === 0)
      throw new BusinessRuleViolationError(
        'Cannot place an empty order',
        'EMPTY_ORDER',
      );
    this.status = OrderStatus.PLACED;
  }

  /** Processes payment. Returns change to give back to customer. */
  pay(paymentAmount: Money): Money {
    this.ensureStatus(OrderStatus.PLACED, 'Order must be PLACED to pay');
    if (paymentAmount.isLessThan(this.total)) {
      throw new BusinessRuleViolationError(
        `Insufficient payment. Required: ${this.total.format()}, received: ${paymentAmount.format()}`,
        'INSUFFICIENT_PAYMENT',
      );
    }
    this.status = OrderStatus.PAID;
    return paymentAmount.subtract(this.total);
  }

  complete(): void {
    this.ensureStatus(OrderStatus.PAID, 'Order must be PAID to complete');
    this.status = OrderStatus.COMPLETED;
    this.completedAt = new Date();
  }

  cancel(): void {
    if (this.status === OrderStatus.COMPLETED) {
      throw new BusinessRuleViolationError(
        'Cannot cancel a completed order',
        'INVALID_ORDER_STATE',
      );
    }
    if (this.status === OrderStatus.CANCELLED) {
      throw new BusinessRuleViolationError(
        'Order is already cancelled',
        'INVALID_ORDER_STATE',
      );
    }
    this.status = OrderStatus.CANCELLED;
  }

  // ==================== Helpers ====================

  private ensureStatus(expected: OrderStatus, message: string): void {
    if (this.status !== expected) {
      throw new BusinessRuleViolationError(message, 'INVALID_ORDER_STATE');
    }
  }

  // ==================== Serialization ====================

  toResponse() {
    return {
      id: this.id,
      customerName: this.customerName,
      status: this.status,
      items: this.items.map((i) => i.toJSON()),
      subtotal: this.subtotal.toJSON(),
      tax: this.tax.toJSON(),
      total: this.total.toJSON(),
      createdAt: this.createdAt.toISOString(),
      completedAt: this.completedAt?.toISOString() ?? null,
    };
  }
}
