import {
  InvalidArgumentError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import {
  SaleItem,
  SaleItemProps,
  OverrideSaleItemPriceInput,
  ApplySaleItemDiscountInput,
} from './sale-item.entity';
import { InvalidDueDateError } from './sale.errors';

export type SaleStatus = 'DRAFT' | 'CONFIRMED';
export type SaleChannel = 'POS' | 'ONLINE';
export type SaleDeliveryStatus = 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';

export interface ConfirmSaleInput {
  confirmedAt: Date;
  folio: string;
}

export interface CreateSaleProps {
  id: string;
  userId: string;
}

export interface SaleFromPersistenceProps {
  id: string;
  userId: string;
  status: SaleStatus;
  channel?: SaleChannel;
  register?: string;
  deliveryStatus?: SaleDeliveryStatus;
  customerId?: string | null;
  shippingAddressId?: string | null;
  sellerUserId?: string | null;
  dueDate?: Date | null;
  items: SaleItemProps[];
  confirmedAt?: Date | null;
  folio?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscountApplicationResult {
  sale: Sale;
  skippedItems: Array<{ itemId: string; reason: string }>;
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
  private _customerId: string | null;
  private _shippingAddressId: string | null;
  private _dueDate: Date | null;

  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly status: SaleStatus,
    public readonly channel: SaleChannel,
    public readonly register: string,
    public readonly deliveryStatus: SaleDeliveryStatus,
    customerId: string | null,
    shippingAddressId: string | null,
    public readonly sellerUserId: string | null,
    dueDate: Date | null,
    items: SaleItem[] = [],
    public readonly confirmedAt?: Date,
    public readonly folio?: string,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
  ) {
    this._items = items;
    this._customerId = customerId;
    this._shippingAddressId = shippingAddressId;
    this._dueDate = dueDate;
  }

  static create(props: CreateSaleProps): Sale {
    if (!props.id || props.id.trim() === '') {
      throw new InvalidArgumentError('Sale ID cannot be empty');
    }
    if (!props.userId || props.userId.trim() === '') {
      throw new InvalidArgumentError('User ID cannot be empty');
    }

    return new Sale(
      props.id,
      props.userId,
      'DRAFT',
      'POS',
      'Principal',
      'DELIVERED',
      null,
      null,
      null,
      null,
    );
  }

  static fromPersistence(props: SaleFromPersistenceProps): Sale {
    const items = props.items.map((itemData) =>
      SaleItem.fromPersistence(itemData),
    );

    return new Sale(
      props.id,
      props.userId,
      props.status,
      props.channel ?? 'POS',
      props.register ?? 'Principal',
      props.deliveryStatus ?? 'DELIVERED',
      props.customerId ?? null,
      props.shippingAddressId ?? null,
      props.sellerUserId ?? null,
      props.dueDate ?? null,
      items,
      props.confirmedAt ?? undefined,
      props.folio ?? undefined,
      props.createdAt,
      props.updatedAt,
    );
  }

  confirm(input: ConfirmSaleInput): Sale {
    if (this.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        'SALE_ALREADY_CONFIRMED',
        'SALE_ALREADY_CONFIRMED',
      );
    }

    if (!(input.confirmedAt instanceof Date)) {
      throw new InvalidArgumentError('confirmedAt must be a valid date');
    }

    if (!input.folio || input.folio.trim() === '') {
      throw new InvalidArgumentError('folio cannot be empty');
    }

    return new Sale(
      this.id,
      this.userId,
      'CONFIRMED',
      this.channel,
      this.register,
      this.deliveryStatus,
      this.customerId,
      this.shippingAddressId,
      this.sellerUserId,
      this._dueDate,
      [...this._items],
      input.confirmedAt,
      input.folio,
      this.createdAt,
      this.updatedAt,
    );
  }

  get items(): ReadonlyArray<SaleItem> {
    return this._items;
  }

  get customerId(): string | null {
    return this._customerId;
  }

  get shippingAddressId(): string | null {
    return this._shippingAddressId;
  }

  get dueDate(): Date | null {
    return this._dueDate;
  }

  setDueDate(date: Date | null): void {
    if (
      date !== null &&
      this.confirmedAt !== undefined &&
      date.getTime() < this.confirmedAt.getTime()
    ) {
      throw new InvalidDueDateError();
    }

    this._dueDate = date;
  }

  assignCustomer(customerId: string, shippingAddressId?: string | null): void {
    this.ensureDraft();

    if (customerId !== this._customerId) {
      this._shippingAddressId = null;
    }

    this._customerId = customerId;
    this._shippingAddressId = shippingAddressId ?? null;
  }

  clearCustomer(): void {
    this.ensureDraft();
    this._customerId = null;
    this._shippingAddressId = null;
  }

  setShippingAddress(addressId: string | null): void {
    this.ensureDraft();

    if (addressId !== null && this._customerId === null) {
      throw new BusinessRuleViolationError(
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
        'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
      );
    }

    this._shippingAddressId = addressId;
  }

  private ensureDraft(): void {
    if (this.status !== 'DRAFT') {
      throw new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT');
    }
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

  removeItem(itemId: string): void {
    const itemIndex = this._items.findIndex((item) => item.id === itemId);
    if (itemIndex === -1) {
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );
    }

    this._items.splice(itemIndex, 1);
  }

  overrideItemPrice(itemId: string, input: OverrideSaleItemPriceInput): void {
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );
    }

    item.overridePrice(input);
  }

  applyItemDiscount(itemId: string, input: ApplySaleItemDiscountInput): void {
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );
    }
    item.applyDiscount(input);
  }

  applyGlobalDiscount(
    input: ApplySaleItemDiscountInput,
  ): DiscountApplicationResult {
    const skippedItems: Array<{ itemId: string; reason: string }> = [];
    const strategy = input.strategy ?? 'replace';

    for (const item of this._items) {
      if (strategy === 'skip' && item.discountType !== null) {
        skippedItems.push({
          itemId: item.id,
          reason: 'ALREADY_DISCOUNTED',
        });
        continue;
      }

      try {
        item.applyDiscount(input);
      } catch (error) {
        if (
          input.type === 'amount' &&
          ((error instanceof BusinessRuleViolationError &&
            error.code === 'DISCOUNT_AMOUNT_INVALID') ||
            (error instanceof InvalidArgumentError &&
              error.message === 'DISCOUNT_AMOUNT_INVALID'))
        ) {
          skippedItems.push({
            itemId: item.id,
            reason: 'DISCOUNT_AMOUNT_INVALID',
          });
          continue;
        }
        throw error;
      }
    }

    return {
      sale: this,
      skippedItems,
    };
  }

  removeItemDiscount(itemId: string): void {
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      );
    }
    item.removeDiscount();
  }

  removeGlobalDiscount(): Sale {
    for (const item of this._items) {
      item.removeDiscount();
    }

    return this;
  }

  toResponse() {
    return {
      id: this.id,
      userId: this.userId,
      status: this.status,
      channel: this.channel,
      register: this.register,
      deliveryStatus: this.deliveryStatus,
      customerId: this.customerId,
      shippingAddressId: this.shippingAddressId,
      sellerUserId: this.sellerUserId,
      dueDate: this.dueDate ? this.dueDate.toISOString() : null,
      confirmedAt: this.confirmedAt,
      folio: this.folio,
      items: this._items.map((item) => item.toResponse()),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
