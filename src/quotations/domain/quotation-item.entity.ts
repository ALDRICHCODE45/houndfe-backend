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
    public readonly appliedPriceListId: string | null,
    public readonly customPriceCents: number | null,
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

  get discountType(): QuotationItemDiscountType | null {
    return this._discountType;
  }

  get discountValue(): number | null {
    return this._discountValue;
  }

  get discountAmountCents(): number {
    return this._discountAmountCents;
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
      appliedPriceListId: this.appliedPriceListId,
      customPriceCents: this.customPriceCents,
      discountType: this._discountType,
      discountValue: this._discountValue,
      discountAmountCents: this._discountAmountCents,
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
