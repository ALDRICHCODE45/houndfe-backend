import { InvalidArgumentError } from '../../shared/domain/domain-error';

export type QuotationItemPriceSource = 'PRICE_LIST' | 'CUSTOM';

export type QuotationItemDiscountType = 'amount' | 'percentage';

export interface QuotationItemProps {
  id: string;
  quotationId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  unitPriceCurrency?: string;
  /**
   * Source of `unitPriceCents`. Defaults to `PRICE_LIST` (the price-list
   * resolver result). `CUSTOM` is set when the seller overrides the price
   * via `overrideItemPrice` (WU3).
   */
  priceSource?: QuotationItemPriceSource;
  /** Price list that resolved `unitPriceCents`. Null for CUSTOM overrides. */
  appliedPriceListId?: string | null;
  /** CUSTOM override value. Null when `priceSource === 'PRICE_LIST'`. */
  customPriceCents?: number | null;
  /** Per-line discount type. Null = no per-line discount. */
  discountType?: QuotationItemDiscountType | null;
  /** Per-line discount value (cents for amount, 1..99 for percentage). */
  discountValue?: number | null;
  /** Per-line discount amount in cents. Defaults to 0. */
  discountAmountCents?: number;
  /**
   * Promotion back-reference. Null = no per-line promo applied; set when
   * a MANUAL or AUTOMATIC promotion was applied via recompute.
   */
  promotionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * QuotationItem — line item on a quotation.
 *
 * Mirrors the SaleItem aggregate shape, minus BXGY/ADVANCED reward state
 * (quotations don't carry whole-line cents rewards). Mutation surface is
 * intentionally narrow in WU1; price override + recompute land in WU3.
 *
 * Business rules:
 * - Quantity must be >= 1.
 * - Unit price must be >= 0.
 * - `priceSource` is always either `PRICE_LIST` (default) or `CUSTOM`.
 * - `promotionId` round-trips through `fromPersistence` so a reload
 *   preserves the engine's per-line attribution.
 */
export class QuotationItem {
  /**
   * WU3 — promotion title snapshot. Set by `applyDiscount`; surfaced on
   * the wire via `toResponse().discountTitle`. Null on non-discounted
   * lines. Mirrors `SaleItem.discountTitle`.
   */
  private _discountTitle: string | null = null;

  private constructor(
    public readonly id: string,
    public readonly quotationId: string,
    public readonly productId: string,
    public readonly variantId: string | null,
    public readonly productName: string,
    public readonly variantName: string | null,
    private _quantity: number,
    private _unitPriceCents: number,
    public readonly unitPriceCurrency: string,
    private _priceSource: QuotationItemPriceSource,
    private _appliedPriceListId: string | null,
    private _customPriceCents: number | null,
    private _discountType: QuotationItemDiscountType | null,
    private _discountValue: number | null,
    private _discountAmountCents: number,
    private _promotionId: string | null,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
  ) {}

  static create(props: QuotationItemProps): QuotationItem {
    if (!props.id || props.id.trim() === '') {
      throw new InvalidArgumentError('QuotationItem ID cannot be empty');
    }
    if (!props.productId || props.productId.trim() === '') {
      throw new InvalidArgumentError('Product ID cannot be empty');
    }
    if (!props.productName || props.productName.trim() === '') {
      throw new InvalidArgumentError('Product name cannot be empty');
    }
    if (!Number.isInteger(props.quantity) || props.quantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }
    if (!Number.isInteger(props.unitPriceCents) || props.unitPriceCents < 0) {
      throw new InvalidArgumentError('Unit price cannot be negative');
    }

    return new QuotationItem(
      props.id,
      props.quotationId,
      props.productId,
      props.variantId ?? null,
      props.productName,
      props.variantName ?? null,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency ?? 'MXN',
      props.priceSource ?? 'PRICE_LIST',
      props.appliedPriceListId ?? null,
      props.customPriceCents ?? null,
      props.discountType ?? null,
      props.discountValue ?? null,
      props.discountAmountCents ?? 0,
      props.promotionId ?? null,
      props.createdAt,
      props.updatedAt,
    );
  }

  static fromPersistence(props: QuotationItemProps): QuotationItem {
    return new QuotationItem(
      props.id,
      props.quotationId,
      props.productId,
      props.variantId ?? null,
      props.productName,
      props.variantName ?? null,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency ?? 'MXN',
      props.priceSource ?? 'PRICE_LIST',
      props.appliedPriceListId ?? null,
      props.customPriceCents ?? null,
      props.discountType ?? null,
      props.discountValue ?? null,
      props.discountAmountCents ?? 0,
      props.promotionId ?? null,
      props.createdAt,
      props.updatedAt,
    );
  }

  // ── Getters ──────────────────────────────────────────────────────────

  get quantity(): number {
    return this._quantity;
  }

  get unitPriceCents(): number {
    return this._unitPriceCents;
  }

  /** Gross per-line subtotal (pre-discount). Equals `unitPriceCents × qty`. */
  get subtotalCents(): number {
    return this._unitPriceCents * this._quantity;
  }

  get priceSource(): QuotationItemPriceSource {
    return this._priceSource;
  }

  get appliedPriceListId(): string | null {
    return this._appliedPriceListId;
  }

  get customPriceCents(): number | null {
    return this._customPriceCents;
  }

  get discountType(): QuotationItemDiscountType | null {
    return this._discountType;
  }

  get discountValue(): number | null {
    return this._discountValue;
  }

  get discountAmountCents(): number {
    return this._discountAmountCents;
  }

  get discountTitle(): string | null {
    return this._discountTitle;
  }

  get promotionId(): string | null {
    return this._promotionId;
  }

  // ── Mutators ─────────────────────────────────────────────────────────

  changeQuantity(newQuantity: number): void {
    if (!Number.isInteger(newQuantity) || newQuantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }
    this._quantity = newQuantity;
  }

  matches(productId: string, variantId: string | null): boolean {
    return this.productId === productId && this.variantId === variantId;
  }

  /**
   * WU3 — Engine-driven tier re-resolution on non-sticky lines (addItem,
   * updateItemQuantity, setPriceList). Mutates `_unitPriceCents` +
   * `_priceSource` + `_appliedPriceListId` only — NEVER touches discount
   * fields and NEVER sets `priceSource: 'CUSTOM'` (the sticky override
   * is exclusively an `overridePrice` contract).
   *
   * Mirrors `SaleItem.reprice` (sales/domain/sale-item.entity.ts:381).
   * The `priceSource` is restricted to `'PRICE_LIST'` here; `'CUSTOM'` is
   * rejected because marking a line sticky is `overridePrice`'s contract.
   */
  reprice(input: {
    priceCents: number;
    priceSource: 'PRICE_LIST' | 'CUSTOM';
    appliedPriceListId: string | null;
  }): void {
    if (input.priceSource === 'CUSTOM') {
      throw new InvalidArgumentError('INVALID_REPRICE_INPUT');
    }
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw new InvalidArgumentError('INVALID_REPRICE_INPUT');
    }
    this._unitPriceCents = input.priceCents;
    this._priceSource = input.priceSource;
    this._appliedPriceListId = input.appliedPriceListId;
  }

  /**
   * WU3 — Cashier-explicit price override. Marks the line sticky
   * (`priceSource = 'CUSTOM'`) and clears any prior per-line discount
   * fields so the recompute can re-apply AUTO promos on the new baseline.
   * Mirrors `SaleItem.overridePrice` (sales/domain/sale-item.entity.ts:348).
   */
  overridePrice(input: {
    priceCents: number;
    priceSource: 'PRICE_LIST' | 'CUSTOM';
    appliedPriceListId: string | null;
    customPriceCents: number | null;
  }): void {
    if (input.priceSource === 'PRICE_LIST') {
      if (!input.appliedPriceListId || input.customPriceCents !== null) {
        throw new InvalidArgumentError('INVALID_PRICE_OVERRIDE_INPUT');
      }
    }
    if (input.priceSource === 'CUSTOM') {
      if (!input.customPriceCents || input.appliedPriceListId !== null) {
        throw new InvalidArgumentError('INVALID_PRICE_OVERRIDE_INPUT');
      }
    }
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw new InvalidArgumentError('INVALID_PRICE_OVERRIDE_INPUT');
    }
    this._unitPriceCents = input.priceCents;
    this._priceSource = input.priceSource;
    this._appliedPriceListId = input.appliedPriceListId;
    this._customPriceCents = input.customPriceCents;
    this.clearDiscountFields();
  }

  /**
   * WU3 — Apply a per-line discount (the engine's per-unit result row).
   * Mirrors `SaleItem.applyDiscount` (sales/domain/sale-item.entity.ts:394).
   * Used by the recompute pipeline after every draft mutation.
   */
  applyDiscount(input: {
    type: 'amount' | 'percentage';
    amountCents?: number;
    percent?: number;
    discountTitle?: string;
    promotionId?: string | null;
  }): void {
    const hasAmount = input.amountCents !== undefined;
    const hasPercent = input.percent !== undefined;

    if (hasAmount === hasPercent) {
      throw new InvalidArgumentError('INVALID_DISCOUNT_INPUT');
    }
    if (input.type === 'amount' && !hasAmount) {
      throw new InvalidArgumentError('INVALID_DISCOUNT_INPUT');
    }
    if (input.type === 'percentage' && !hasPercent) {
      throw new InvalidArgumentError('INVALID_DISCOUNT_INPUT');
    }

    const baseline = this._unitPriceCents;
    const discountAmountCents = this.computeDiscountAmountCents(input, baseline);
    if (baseline - discountAmountCents < 1) {
      throw new InvalidArgumentError('DISCOUNT_AMOUNT_INVALID');
    }

    this._discountType = input.type;
    this._discountValue =
      input.type === 'amount' ? input.amountCents! : input.percent!;
    this._discountAmountCents = discountAmountCents;
    this._discountTitle = input.discountTitle ?? null;
    this._promotionId = input.promotionId ?? null;
    this._unitPriceCents = baseline - discountAmountCents;
  }

  /**
   * WU3 — Remove any per-line discount applied by `applyDiscount` (manual
   * or promo-sourced). Restores `unitPriceCents` to the pre-discount
   * baseline. Mirrors `SaleItem.removeDiscount`
   * (sales/domain/sale-item.entity.ts:430).
   */
  removeDiscount(): void {
    if (this._discountAmountCents > 0) {
      this._unitPriceCents += this._discountAmountCents;
    }
    this.clearDiscountFields();
  }

  private clearDiscountFields(): void {
    this._discountType = null;
    this._discountValue = null;
    this._discountAmountCents = 0;
    this._promotionId = null;
  }

  private computeDiscountAmountCents(
    input: {
      type: 'amount' | 'percentage';
      amountCents?: number;
      percent?: number;
    },
    baseline: number,
  ): number {
    if (input.type === 'amount') {
      return Math.min(input.amountCents ?? 0, baseline);
    }
    // percentage — clamp 1..99 (mirrors the engine's clamp invariant).
    const raw = input.percent ?? 0;
    const safePercent = Math.min(Math.max(Math.trunc(raw), 1), 99);
    return Math.round((baseline * safePercent) / 100);
  }

  toResponse() {
    return {
      id: this.id,
      quotationId: this.quotationId,
      productId: this.productId,
      variantId: this.variantId,
      productName: this.productName,
      variantName: this.variantName,
      quantity: this.quantity,
      unitPriceCents: this.unitPriceCents,
      unitPriceCurrency: this.unitPriceCurrency,
      priceSource: this._priceSource,
      appliedPriceListId: this._appliedPriceListId,
      customPriceCents: this._customPriceCents,
      discountType: this._discountType,
      discountValue: this._discountValue,
      discountAmountCents: this._discountAmountCents,
      // WU4 — surface the per-line discount title on the wire so the
      // PDF template + email body can render the discount column
      // verbatim (matches the Sale item contract).
      discountTitle: this._discountTitle,
      promotionId: this._promotionId,
      /** NET per-line subtotal. For WU1, equals `unitPrice × qty` because no
       *  per-line discount has been applied yet. WU3 widens this once the
       *  recompute path lands. */
      subtotalCents: this.subtotalCents,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
