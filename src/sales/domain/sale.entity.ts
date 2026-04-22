import {
  InvalidArgumentError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import { SaleItem, SaleItemProps } from './sale-item.entity';

export type SaleStatus = 'DRAFT';

export interface CreateSaleProps {
  id: string;
  userId: string;
}

export interface SaleFromPersistenceProps {
  id: string;
  userId: string;
  status: SaleStatus;
  items: SaleItemProps[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Sale Aggregate Root - manages POS sale drafts
 *
 * Business rules:
 * - Status is always DRAFT in v1
 * - Each sale is owned by a single user
 * - Items stack by product+variant combination
 * - Price is frozen at add-time
 * - Multiple drafts per user are allowed
 */
export class Sale {
  private _items: SaleItem[] = [];

  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly status: SaleStatus,
    items: SaleItem[] = [],
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
  ) {
    this._items = items;
  }

  static create(props: CreateSaleProps): Sale {
    if (!props.id || props.id.trim() === '') {
      throw new InvalidArgumentError('Sale ID cannot be empty');
    }
    if (!props.userId || props.userId.trim() === '') {
      throw new InvalidArgumentError('User ID cannot be empty');
    }

    return new Sale(props.id, props.userId, 'DRAFT');
  }

  static fromPersistence(props: SaleFromPersistenceProps): Sale {
    const items = props.items.map((itemData) =>
      SaleItem.fromPersistence(itemData),
    );

    return new Sale(
      props.id,
      props.userId,
      props.status,
      items,
      props.createdAt,
      props.updatedAt,
    );
  }

  get items(): ReadonlyArray<SaleItem> {
    return this._items;
  }

  /**
   * Add item to sale, stacking if same product+variant already exists
   */
  addItem(itemProps: SaleItemProps): void {
    // Validate item data
    const newItem = SaleItem.create(itemProps);

    // Check if item with same product+variant exists (stacking logic)
    const existingItem = this._items.find((item) =>
      item.matches(newItem.productId, newItem.variantId),
    );

    if (existingItem) {
      // Stack quantities
      existingItem.changeQuantity(existingItem.quantity + newItem.quantity);
    } else {
      // Add as new item
      this._items.push(newItem);
    }
  }

  /**
   * Update quantity of an existing item by ID
   */
  updateItemQuantity(itemId: string, newQuantity: number): void {
    if (newQuantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }

    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(
        `Item with ID ${itemId} not found in sale`,
      );
    }

    item.changeQuantity(newQuantity);
  }

  /**
   * Remove all items from the sale (idempotent)
   */
  clearItems(): void {
    this._items = [];
  }

  toResponse() {
    return {
      id: this.id,
      userId: this.userId,
      status: this.status,
      items: this._items.map((item) => item.toResponse()),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
