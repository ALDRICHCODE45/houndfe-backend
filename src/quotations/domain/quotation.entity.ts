import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import {
  QuotationItem,
  type QuotationItemProps,
} from './quotation-item.entity';
import {
  QuotationHasNoItemsError,
  QuotationItemNotFoundError,
  QuotationNotDraftError,
} from './quotation.errors';

/**
 * Quotation lifecycle states. Distinct from Sale (CONFIRMED/CANCELED)
 * because a quotation is a pre-sale pricing document — it goes
 * DRAFT → SENT → EXPIRED/CANCELLED, never CONFIRMED.
 *
 * - `DRAFT`     — open for edits (items, customer, price list, expiry, promos)
 * - `SENT`      — delivered to the customer (PDF + email). Immutable.
 * - `EXPIRED`   — lazy transition when `expiresAt` is in the past on any read.
 *                 Idempotent: subsequent reads keep the same effective status.
 * - `CANCELLED` — terminal. `cancelReason` is set.
 */
export type QuotationStatus = 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED';

/**
 * Reason captured when a quotation is cancelled. Mirrors the Sale enum
 * minus the order-error/out-of-stock cases (a quotation never goes to
 * order-confirmation, so those reasons don't apply) and adds
 * `PRICE_OBJECTION` (sales-rep override path) + `EXPIRED` (auto-cancel
 * path).
 */
export type QuotationCancelReason =
  | 'CUSTOMER_REQUEST'
  | 'PRICE_OBJECTION'
  | 'EXPIRED'
  | 'OTHER';

export interface CreateQuotationProps {
  id: string;
  sellerUserId: string;
  customerId?: string | null;
  globalPriceListId?: string | null;
}

export interface QuotationFromPersistenceProps {
  id: string;
  sellerUserId: string;
  customerId: string | null;
  globalPriceListId: string | null;
  /**
   * WU1 — cashier-explicit price-list discriminator. False on freshly-
   * created drafts and after `assignCustomer` auto-seeds; true after any
   * `PUT /price-list` (including a null clear). When true,
   * `assignCustomer` MUST NOT auto-seed — protects the cashier's
   * choice against an unrelated customer change.
   */
  priceListExplicitlySet: boolean;
  status: QuotationStatus;
  expiresAt: Date | null;
  cancelReason: QuotationCancelReason | null;
  canceledAt?: Date | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  manuallyEnded: boolean;
  items: QuotationItemProps[];
  vetoedPromotionIds: ReadonlyArray<string>;
  optedInManualPromotionIds: ReadonlyArray<string>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Quotation Aggregate Root — manages quotation drafts.
 *
 * Mirrors the Sale aggregate layout (private constructor, `static create()`
 * + `static fromPersistence()`, mutation methods reject non-DRAFT). WU1
 * covers the persistence-only surface; WU2 wires the service, WU3 adds
 * item/promo/expiry mutation methods, and WU4 adds the PDF/email send
 * path.
 *
 * Business rules:
 * - Status starts as `DRAFT` on `create()`.
 * - All item/customer/price-list/expiry mutations reject non-DRAFT.
 * - `cancel(reason)` is idempotent: calling it on a CANCELLED quotation
 *   returns the same instance; on a non-terminal status it returns a new
 *   CANCELLED instance.
 * - `expiresAt` triggers a lazy `EXPIRED` transition on any read past the
 *   date — never on writes.
 */
export class Quotation {
  private _items: QuotationItem[] = [];
  private _customerId: string | null;
  private _globalPriceListId: string | null;
  private _priceListExplicitlySet: boolean;
  private _expiresAt: Date | null;
  private _vetoedPromotionIds: string[];
  private _optedInManualPromotionIds: string[];

  private constructor(
    public readonly id: string,
    public readonly sellerUserId: string,
    public readonly status: QuotationStatus,
    public readonly subtotalCents: number = 0,
    public readonly discountCents: number = 0,
    public readonly totalCents: number = 0,
    public readonly manuallyEnded: boolean = false,
    public readonly cancelReason: QuotationCancelReason | null = null,
    public readonly canceledAt: Date | null = null,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    customerId: string | null = null,
    globalPriceListId: string | null = null,
    priceListExplicitlySet: boolean = false,
    expiresAt: Date | null = null,
    items: QuotationItem[] = [],
    vetoedPromotionIds: ReadonlyArray<string> = [],
    optedInManualPromotionIds: ReadonlyArray<string> = [],
  ) {
    this._items = items;
    this._customerId = customerId;
    this._globalPriceListId = globalPriceListId;
    this._priceListExplicitlySet = priceListExplicitlySet;
    this._expiresAt = expiresAt;
    this._vetoedPromotionIds = [...vetoedPromotionIds];
    this._optedInManualPromotionIds = [...optedInManualPromotionIds];
  }

  // ── Factories ────────────────────────────────────────────────────────

  static create(props: CreateQuotationProps): Quotation {
    if (!props.id || props.id.trim() === '') {
      throw new InvalidArgumentError('Quotation ID cannot be empty');
    }
    if (!props.sellerUserId || props.sellerUserId.trim() === '') {
      throw new InvalidArgumentError('Seller user ID cannot be empty');
    }

    return new Quotation(
      props.id,
      props.sellerUserId,
      'DRAFT',
      0,
      0,
      0,
      false,
      null,
      null,
      undefined,
      undefined,
      props.customerId ?? null,
      props.globalPriceListId ?? null,
      false,
      null,
    );
  }

  static fromPersistence(props: QuotationFromPersistenceProps): Quotation {
    const items = props.items.map((item) =>
      QuotationItem.fromPersistence(item),
    );

    return new Quotation(
      props.id,
      props.sellerUserId,
      props.status,
      props.subtotalCents,
      props.discountCents,
      props.totalCents,
      props.manuallyEnded,
      props.cancelReason,
      props.canceledAt ?? null,
      props.createdAt,
      props.updatedAt,
      props.customerId ?? null,
      props.globalPriceListId ?? null,
      props.priceListExplicitlySet ?? false,
      props.expiresAt ?? null,
      items,
      props.vetoedPromotionIds ?? [],
      props.optedInManualPromotionIds ?? [],
    );
  }

  // ── Item accessors + lifecycle ───────────────────────────────────────

  get items(): ReadonlyArray<QuotationItem> {
    return this._items;
  }

  get customerId(): string | null {
    return this._customerId;
  }

  get globalPriceListId(): string | null {
    return this._globalPriceListId;
  }

  /**
   * WU1 — cashier-explicit price-list discriminator. False on freshly-
   * created drafts and after `assignCustomer` auto-seeds; true after any
   * `PUT /price-list` (including a null clear). `assignCustomer` only
   * seeds when this flag is false.
   */
  get priceListExplicitlySet(): boolean {
    return this._priceListExplicitlySet;
  }

  get expiresAt(): Date | null {
    return this._expiresAt;
  }

  get vetoedPromotionIds(): ReadonlyArray<string> {
    return this._vetoedPromotionIds;
  }

  get optedInManualPromotionIds(): ReadonlyArray<string> {
    return this._optedInManualPromotionIds;
  }

  /** Add a new line or stack the quantity on a matching product+variant. */
  addItem(itemProps: QuotationItemProps): void {
    this.ensureDraft();
    const newItem = QuotationItem.create(itemProps);

    const existingItem = this._items.find((item) =>
      item.matches(newItem.productId, newItem.variantId),
    );

    if (existingItem) {
      existingItem.changeQuantity(existingItem.quantity + newItem.quantity);
    } else {
      this._items.push(newItem);
    }
  }

  updateItemQuantity(itemId: string, newQuantity: number): void {
    this.ensureDraft();
    if (!Number.isInteger(newQuantity) || newQuantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new QuotationItemNotFoundError(itemId);
    }
    item.changeQuantity(newQuantity);
  }

  removeItem(itemId: string): void {
    this.ensureDraft();
    const itemIndex = this._items.findIndex((item) => item.id === itemId);
    if (itemIndex === -1) {
      throw new QuotationItemNotFoundError(itemId);
    }
    this._items.splice(itemIndex, 1);
  }

  clearItems(): void {
    this.ensureDraft();
    this._items = [];
  }

  /**
   * WU3 — Override an item's unit price. Delegates to
   * `QuotationItem.overridePrice` which marks the line sticky
   * (`priceSource = 'CUSTOM'`) and clears prior per-line discount
   * fields so the recompute can re-apply AUTO promos on the new
   * baseline. Mirrors `Sale.overrideItemPrice`.
   */
  overrideItemPrice(
    itemId: string,
    input: {
      priceCents: number;
      priceSource: 'PRICE_LIST' | 'CUSTOM';
      appliedPriceListId: string | null;
      customPriceCents: number | null;
    },
  ): void {
    this.ensureDraft();
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new QuotationItemNotFoundError(itemId);
    }
    item.overridePrice(input);
  }

  /**
   * WU3 — Apply the engine's per-line result row. Only the per-unit
   * `PRODUCT_DISCOUNT` shape is supported on quotations (BXGY/ADVANCED
   * whole-line rewards are excluded by the engine's `isSupportedEngineType`
   * gate when the quotation surfaces its `context` — the WU3 widening is
   * additive but the engine evaluator is identical at this layer).
   */
  applyItemDiscount(
    itemId: string,
    input: {
      type: 'amount' | 'percentage';
      amountCents?: number;
      percent?: number;
      discountTitle?: string;
      promotionId?: string | null;
    },
  ): void {
    this.ensureDraft();
    const item = this._items.find((i) => i.id === itemId);
    if (!item) {
      throw new QuotationItemNotFoundError(itemId);
    }
    item.applyDiscount(input);
  }

  // ── Customer + price list ────────────────────────────────────────────

  /**
   * WU1 — Assign a customer to the quotation. When the caller supplies a
   * `priceListId`, the quotation's `globalPriceListId` auto-seeds UNLESS
   * the cashier has already set one explicitly (`priceListExplicitlySet`).
   *
   * The service layer resolves the customer's `globalPriceListId` and
   * passes it down — the entity just stores what it's told.
   */
  assignCustomer(customerId: string, priceListId: string | null): void {
    this.ensureDraft();
    if (!customerId || customerId.trim() === '') {
      throw new InvalidArgumentError('Customer ID cannot be empty');
    }
    this._customerId = customerId;
    if (!this._priceListExplicitlySet) {
      this._globalPriceListId = priceListId;
    }
  }

  clearCustomer(): void {
    this.ensureDraft();
    this._customerId = null;
    if (!this._priceListExplicitlySet) {
      this._globalPriceListId = null;
    }
  }

  /**
   * WU1 — Set the quotation-level price list. `id === null` is a clear;
   * `explicit === true` records the cashier's choice (including the null
   * clear so an unrelated `assignCustomer` cannot re-seed).
   */
  setGlobalPriceList(id: string | null, explicit: boolean): void {
    this.ensureDraft();
    if (id !== null && (typeof id !== 'string' || id.trim() === '')) {
      throw new InvalidArgumentError('INVALID_PRICE_LIST_ID');
    }
    this._globalPriceListId = id;
    this._priceListExplicitlySet = explicit;
  }

  // ── Promotion state (veto / opt-in) ──────────────────────────────────

  /**
   * Add a promotion id to the veto set (idempotent). Cross-clears the
   * opt-in set: if the same id is currently opted-in, the veto wins and
   * the id is REMOVED from the opted-in set. Enforces
   * `optedInManualPromotionIds ∩ vetoedPromotionIds = ∅` at the aggregate
   * level — see the Sale entity for the symmetric invariant.
   */
  addVetoedPromotion(promotionId: string): void {
    this.optOutManualPromotion(promotionId);
    if (!this._vetoedPromotionIds.includes(promotionId)) {
      this._vetoedPromotionIds.push(promotionId);
    }
  }

  removeVetoedPromotion(promotionId: string): void {
    this._vetoedPromotionIds = this._vetoedPromotionIds.filter(
      (id) => id !== promotionId,
    );
  }

  /**
   * Opt in a MANUAL promotion (idempotent). Cross-clears the veto set:
   * if the same id was previously vetoed, the opt-in wins and the id is
   * REMOVED from the veto set.
   */
  optInManualPromotion(promotionId: string): void {
    this.removeVetoedPromotion(promotionId);
    if (!this._optedInManualPromotionIds.includes(promotionId)) {
      this._optedInManualPromotionIds.push(promotionId);
    }
  }

  optOutManualPromotion(promotionId: string): void {
    this._optedInManualPromotionIds =
      this._optedInManualPromotionIds.filter((id) => id !== promotionId);
  }

  // ── Expiry + lazy status ─────────────────────────────────────────────

  setExpiry(date: Date | null): void {
    this.ensureDraft();
    this._expiresAt = date;
  }

  /**
   * Lazy status read — applies the `EXPIRED` transition on any read past
   * `expiresAt` (idempotent). CANCELLED is preserved across the check
   * because cancellation is terminal. `SENT` + `expiresAt` past → EXPIRED.
   * `SENT` + no expiry → SENT forever. `DRAFT` + any expiry → DRAFT (the
   * draft mutation will surface EXPIRED on the next read).
   *
   * Pass `now` explicitly in tests for determinism.
   */
  getEffectiveStatus(now?: Date): QuotationStatus {
    if (this.status === 'CANCELLED' || this.status === 'EXPIRED') {
      return this.status;
    }
    if (this._expiresAt === null) {
      return this.status;
    }
    const reference = now ?? new Date();
    return this._expiresAt.getTime() <= reference.getTime()
      ? 'EXPIRED'
      : this.status;
  }

  // ── Send (WU4) ───────────────────────────────────────────────────────

  /**
   * WU4 — Transition the quotation from DRAFT to SENT.
   *
   * The send flow is the ONLY gate to `SENT` — there is no manual
   * transition in the controller surface (per spec scenario "Send is
   * the only gate to SENT"). The service layer calls this method
   * AFTER the email provider confirms the PDF was delivered, so a
   * failure upstream keeps the entity in DRAFT and the throw propagates.
   *
   * Validations (enforced here so the domain is the source of truth,
   * not the service):
   *   - `status === 'DRAFT'` — otherwise `QuotationNotDraftError` (409
   *     via the DomainExceptionFilter).
   *   - `items.length >= 1` — otherwise `QuotationHasNoItemsError` (422).
   *
   * Returns a new instance with `status === 'SENT'` and a fresh
   * `updatedAt`. Mirrors the `cancel` factory pattern (the entity's
   * `status` field is `readonly`, so an in-place mutation would not
   * type-check).
   *
   * The caller (`QuotationsService.send`) is responsible for
   * persisting via `repo.save(sent)`.
   */
  send(sentAt: Date = new Date()): Quotation {
    if (this.status !== 'DRAFT') {
      throw new QuotationNotDraftError(this.status);
    }
    if (this._items.length === 0) {
      throw new QuotationHasNoItemsError(this.id);
    }

    return new Quotation(
      this.id,
      this.sellerUserId,
      'SENT',
      this.subtotalCents,
      this.discountCents,
      this.totalCents,
      this.manuallyEnded,
      this.cancelReason,
      this.canceledAt,
      this.createdAt,
      sentAt,
      this._customerId,
      this._globalPriceListId,
      this._priceListExplicitlySet,
      this._expiresAt,
      [...this._items],
      [...this._vetoedPromotionIds],
      [...this._optedInManualPromotionIds],
    );
  }

  // ── Cancel ───────────────────────────────────────────────────────────

  /**
   * Cancel the quotation. Idempotent: if already CANCELLED, returns the
   * same instance unchanged. On a non-terminal status (DRAFT/SENT/EXPIRED)
   * returns a new CANCELLED instance with `cancelReason` and `canceledAt`
   * set. The caller (service) is responsible for persisting via
   * `repo.save(cancelled)`.
   */
  cancel(
    reason: QuotationCancelReason,
    canceledAt: Date = new Date(),
  ): Quotation {
    if (this.status === 'CANCELLED') {
      return this;
    }

    return new Quotation(
      this.id,
      this.sellerUserId,
      'CANCELLED',
      this.subtotalCents,
      this.discountCents,
      this.totalCents,
      this.manuallyEnded,
      reason,
      canceledAt,
      this.createdAt,
      new Date(),
      this._customerId,
      this._globalPriceListId,
      this._priceListExplicitlySet,
      this._expiresAt,
      [...this._items],
      [...this._vetoedPromotionIds],
      [...this._optedInManualPromotionIds],
    );
  }

  // ── Totals + wire shape ──────────────────────────────────────────────

  /**
   * Order-discount-aware preview totals. Source of truth for DRAFT
   * responses and the future PDF render (WU4). Mirrors Sale's
   * `previewTotals()` contract:
   *
   *   subtotalCents = Σ (basePrice × quantity) BEFORE any per-line discount
   *   discountCents = Σ per-line discountAmountCents
   *   totalCents    = Σ (unitPriceCents × quantity)  (NET, clamped to ≥ 0)
   *
   * WU3 — the engine-driven recompute path can apply per-line discounts
   * (`item.unitPriceCents` is mutated by `applyDiscount` and the saving
   * rides on `discountAmountCents`). The subtotal sums the per-line
   * `discountAmountCents` (the engine's per-line saving) and the total
   * sums the post-discount `unitPriceCents × quantity` (NET).
   *
   * On a fresh DRAFT with no items `subtotalCents === discountCents === 0`
   * and `totalCents === 0`. Symmetric to Sale's `previewTotals()`.
   */
  recomputeTotals(): {
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
  } {
    const subtotalCents = this._items.reduce(
      (sum, item) =>
        sum +
        (item.unitPriceCents + (item.discountAmountCents ?? 0)) *
          item.quantity,
      0,
    );
    const totalCents = this._items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );
    const discountCents = Math.max(0, subtotalCents - totalCents);
    return { subtotalCents, discountCents, totalCents };
  }

  toResponse() {
    const totals = this.recomputeTotals();
    return {
      id: this.id,
      sellerUserId: this.sellerUserId,
      status: this.status,
      customerId: this._customerId,
      globalPriceListId: this._globalPriceListId,
      priceListExplicitlySet: this._priceListExplicitlySet,
      expiresAt: this._expiresAt,
      cancelReason: this.cancelReason,
      canceledAt: this.canceledAt,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      totalCents: totals.totalCents,
      manuallyEnded: this.manuallyEnded,
      items: this._items.map((item) => item.toResponse()),
      appliedPromotions: this.computeAppliedPromotions(),
      vetoedPromotionIds: [...this._vetoedPromotionIds],
      optedInManualPromotionIds: [...this._optedInManualPromotionIds],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Derive the `appliedPromotions` snapshot from items that carry a
   * `promotionId`. Deduplicated by promotionId, discount summed across
   * all items that the promotion touched.
   */
  private computeAppliedPromotions() {
    const byPromo = new Map<
      string,
      { title: string; discountCents: number }
    >();
    for (const item of this._items) {
      if (!item.promotionId) continue;
      const existing = byPromo.get(item.promotionId);
      if (existing) {
        existing.discountCents += item.discountAmountCents;
      } else {
        byPromo.set(item.promotionId, {
          title: item.discountTitle ?? item.promotionId,
          discountCents: item.discountAmountCents,
        });
      }
    }
    return Array.from(byPromo.entries()).map(([promotionId, v]) => ({
      promotionId,
      title: v.title,
      discountCents: v.discountCents,
    }));
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private ensureDraft(): void {
    if (this.status !== 'DRAFT') {
      throw new QuotationNotDraftError(this.status);
    }
  }
}
