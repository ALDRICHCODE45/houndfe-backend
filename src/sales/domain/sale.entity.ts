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
import {
  InvalidDueDateError,
  SaleNotCancellableError,
  SaleDeliveredCannotCancelError,
} from './sale.errors';

export type SaleStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELED';
export type SaleChannel = 'POS' | 'ONLINE';
export type SaleDeliveryStatus =
  | 'PENDING'
  | 'DELIVERED'
  | 'NOT_APPLICABLE'
  | 'SHIPPED';
export type SalePaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';
export type SaleCancelReason =
  | 'CUSTOMER_REQUEST'
  | 'ORDER_ERROR'
  | 'OUT_OF_STOCK'
  | 'DUPLICATE_SALE'
  | 'OTHER';

export interface CancelSaleActor {
  actorId: string;
  canceledAt?: Date;
}

export interface CancelSaleResult {
  sale: Sale;
  refundedCents: number;
}

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
  totalCents?: number;
  paidCents?: number;
  debtCents?: number;
  changeDueCents?: number;
  paymentStatus?: SalePaymentStatus | null;
  canceledAt?: Date | null;
  cancelReason?: SaleCancelReason | null;
  canceledByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Delivery metadata — added for bot-created ONLINE sales (Slice 6) */
  carrierName?: string | null;
  trackingRef?: string | null;
  estimatedDeliveryAt?: Date | null;
  /**
   * Sale-level ORDER_DISCOUNT promotion snapshot. Null = no order promotion
   * applied. Persisted to `sale_promotion_applied`. Defaults to null so
   * existing fromPersistence call sites stay unchanged.
   */
  appliedOrderPromotion?: AppliedOrderPromotionSnapshot | null;
  /**
   * Promotion ids the seller has dismissed on this draft. Persisted to
   * `sale_promotion_vetoes` and feeds the engine's exclusion list.
   */
  vetoedPromotionIds?: ReadonlyArray<string>;
  /**
   * MANUAL promotion ids the seller has opted into on this draft.
   * Default: empty array.
   */
  optedInManualPromotionIds?: ReadonlyArray<string>;
}

/**
 * Sale-level ORDER_DISCOUNT snapshot. Mirrors the columns on
 * `sale_promotion_applied`. `promotionId` may be null when the underlying
 * Promotion row was deleted (SetNull on the FK).
 */
export interface AppliedOrderPromotionSnapshot {
  promotionId: string | null;
  discountType: 'amount' | 'percentage' | null;
  discountValue: number | null;
  discountAmountCents: number;
  discountTitle: string | null;
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
  private _sellerUserId: string | null;
  private _dueDate: Date | null;
  private _carrierName: string | null;
  private _trackingRef: string | null;
  private _estimatedDeliveryAt: Date | null;
  private _appliedOrderPromotion: AppliedOrderPromotionSnapshot | null;
  private _vetoedPromotionIds: string[];
  private _optedInManualPromotionIds: string[];

  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly status: SaleStatus,
    public readonly channel: SaleChannel,
    public readonly register: string,
    public readonly deliveryStatus: SaleDeliveryStatus,
    customerId: string | null,
    shippingAddressId: string | null,
    sellerUserId: string | null,
    dueDate: Date | null,
    items: SaleItem[] = [],
    public readonly confirmedAt?: Date,
    public readonly folio?: string,
    public readonly totalCents: number = 0,
    public readonly paidCents: number = 0,
    public readonly debtCents: number = 0,
    public readonly changeDueCents: number = 0,
    public readonly paymentStatus: SalePaymentStatus | null = null,
    public readonly canceledAt: Date | null = null,
    public readonly cancelReason: SaleCancelReason | null = null,
    public readonly canceledByUserId: string | null = null,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    carrierName: string | null = null,
    trackingRef: string | null = null,
    estimatedDeliveryAt: Date | null = null,
    appliedOrderPromotion: AppliedOrderPromotionSnapshot | null = null,
    vetoedPromotionIds: ReadonlyArray<string> = [],
    optedInManualPromotionIds: ReadonlyArray<string> = [],
  ) {
    this._items = items;
    this._customerId = customerId;
    this._shippingAddressId = shippingAddressId;
    this._sellerUserId = sellerUserId;
    this._dueDate = dueDate;
    this._carrierName = carrierName;
    this._trackingRef = trackingRef;
    this._estimatedDeliveryAt = estimatedDeliveryAt;
    this._appliedOrderPromotion = appliedOrderPromotion;
    this._vetoedPromotionIds = [...vetoedPromotionIds];
    this._optedInManualPromotionIds = [...optedInManualPromotionIds];
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
      props.totalCents ?? 0,
      props.paidCents ?? 0,
      props.debtCents ?? 0,
      props.changeDueCents ?? 0,
      props.paymentStatus ?? null,
      props.canceledAt ?? null,
      props.cancelReason ?? null,
      props.canceledByUserId ?? null,
      props.createdAt,
      props.updatedAt,
      props.carrierName ?? null,
      props.trackingRef ?? null,
      props.estimatedDeliveryAt ?? null,
      props.appliedOrderPromotion ?? null,
      props.vetoedPromotionIds ?? [],
      props.optedInManualPromotionIds ?? [],
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
      this.totalCents,
      this.paidCents,
      this.debtCents,
      this.changeDueCents,
      this.paymentStatus,
      this.canceledAt,
      this.cancelReason,
      this.canceledByUserId,
      this.createdAt,
      this.updatedAt,
    );
  }

  cancel(reason: SaleCancelReason, actor: CancelSaleActor): CancelSaleResult {
    if (this.status !== 'CONFIRMED') {
      throw new SaleNotCancellableError();
    }

    if (
      this.deliveryStatus === 'SHIPPED' ||
      this.deliveryStatus === 'DELIVERED'
    ) {
      throw new SaleDeliveredCannotCancelError();
    }

    const canceledAt = actor.canceledAt ?? new Date();
    const refundedCents =
      this.paymentStatus === 'CREDIT' || this.paidCents === 0
        ? 0
        : this.paidCents;
    const resultingDebtCents =
      this.paymentStatus === 'CREDIT' || this.paidCents === 0
        ? 0
        : this.debtCents;

    return {
      sale: new Sale(
        this.id,
        this.userId,
        'CANCELED',
        this.channel,
        this.register,
        this.deliveryStatus,
        this.customerId,
        this.shippingAddressId,
        this.sellerUserId,
        this._dueDate,
        [...this._items],
        this.confirmedAt,
        this.folio,
        this.totalCents,
        this.paidCents,
        resultingDebtCents,
        this.changeDueCents,
        this.paymentStatus,
        canceledAt,
        reason,
        actor.actorId,
        this.createdAt,
        this.updatedAt,
        this.carrierName,
        this.trackingRef,
        this.estimatedDeliveryAt,
      ),
      refundedCents,
    };
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

  get sellerUserId(): string | null {
    return this._sellerUserId;
  }

  get carrierName(): string | null {
    return this._carrierName;
  }

  get trackingRef(): string | null {
    return this._trackingRef;
  }

  get estimatedDeliveryAt(): Date | null {
    return this._estimatedDeliveryAt;
  }

  // ---------------------------------------------------------------------------
  // Promotion state (Unit 3 — promotionId/sale row mirrors `sale_promotion_applied`
  // and `sale_promotion_vetoes`. The engine (Unit 4) mutates these via the
  // helpers below; persistence mirrors them via the repo's `save`.
  // ---------------------------------------------------------------------------

  /** Sale-level ORDER_DISCOUNT snapshot (null = none). */
  get appliedOrderPromotion(): AppliedOrderPromotionSnapshot | null {
    return this._appliedOrderPromotion;
  }

  /** Promotion ids the seller has dismissed on this draft. */
  get vetoedPromotionIds(): ReadonlyArray<string> {
    return this._vetoedPromotionIds;
  }

  /** MANUAL promotion ids the seller has opted into on this draft. */
  get optedInManualPromotionIds(): ReadonlyArray<string> {
    return this._optedInManualPromotionIds;
  }

  /** Replace the sale-level ORDER_DISCOUNT snapshot. */
  setAppliedOrderPromotion(snapshot: AppliedOrderPromotionSnapshot): void {
    this._appliedOrderPromotion = { ...snapshot };
  }

  /** Clear any applied ORDER_DISCOUNT (used when recompute drops the promo). */
  clearAppliedOrderPromotion(): void {
    this._appliedOrderPromotion = null;
  }

  /** Add a promotion id to the veto set (idempotent). */
  addVetoedPromotion(promotionId: string): void {
    if (!this._vetoedPromotionIds.includes(promotionId)) {
      this._vetoedPromotionIds.push(promotionId);
    }
  }

  /** Remove a promotion id from the veto set (idempotent). */
  removeVetoedPromotion(promotionId: string): void {
    this._vetoedPromotionIds = this._vetoedPromotionIds.filter(
      (id) => id !== promotionId,
    );
  }

  /** Opt in a MANUAL promotion (idempotent). */
  optInManualPromotion(promotionId: string): void {
    if (!this._optedInManualPromotionIds.includes(promotionId)) {
      this._optedInManualPromotionIds.push(promotionId);
    }
  }

  /** Remove a MANUAL opt-in (idempotent). */
  optOutManualPromotion(promotionId: string): void {
    this._optedInManualPromotionIds = this._optedInManualPromotionIds.filter(
      (id) => id !== promotionId,
    );
  }

  /**
   * C2: order-discount-aware preview totals. Source of truth for BOTH draft
   * preview (Unit 4) and charge totals (Unit 5) — never duplicate the math.
   *
   *   subtotalCents = Σ(unitPriceCents × quantity)
   *   orderDiscountCents = appliedOrderPromotion?.discountAmountCents ?? 0
   *   discountCents = min(subtotalCents, orderDiscountCents)
   *   totalCents = max(0, subtotalCents - orderDiscountCents)
   */
  previewTotals(): {
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
  } {
    const subtotalCents = this._items.reduce(
      (sum, item) => sum + item.subtotalCents,
      0,
    );
    const orderDiscountCents =
      this._appliedOrderPromotion?.discountAmountCents ?? 0;
    const discountCents = Math.min(subtotalCents, orderDiscountCents);
    const totalCents = Math.max(0, subtotalCents - orderDiscountCents);
    return { subtotalCents, discountCents, totalCents };
  }

  /**
   * Set delivery carrier metadata for ONLINE/bot-created sales.
   * Called when a sale is dispatched or delivery is scheduled.
   */
  setDeliveryMetadata(input: {
    carrierName: string | null;
    trackingRef: string | null;
    estimatedDeliveryAt: Date | null;
  }): void {
    this._carrierName = input.carrierName;
    this._trackingRef = input.trackingRef;
    this._estimatedDeliveryAt = input.estimatedDeliveryAt;
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

  assignSeller(userId: string): void {
    this._sellerUserId = userId;
  }

  clearSeller(): void {
    this._sellerUserId = null;
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
      totalCents: this.totalCents,
      paidCents: this.paidCents,
      debtCents: this.debtCents,
      changeDueCents: this.changeDueCents,
      paymentStatus: this.paymentStatus,
      canceledAt: this.canceledAt,
      cancelReason: this.cancelReason,
      canceledByUserId: this.canceledByUserId,
      items: this._items.map((item) => item.toResponse()),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
