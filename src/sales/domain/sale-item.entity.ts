import { InvalidArgumentError } from '../../shared/domain/domain-error';

export interface SaleItemProps {
  id: string;
  saleId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  imageUrl?: string | null;
  quantity: number;
  unitPriceCents: number;
  unitPriceCurrency: string;
  originalPriceCents?: number | null;
  priceSource?: 'default' | 'price_list' | 'custom' | null;
  appliedPriceListId?: string | null;
  customPriceCents?: number | null;
  discountType?: 'amount' | 'percentage' | null;
  discountValue?: number | null;
  discountAmountCents?: number | null;
  prePriceCentsBeforeDiscount?: number | null;
  discountTitle?: string | null;
  discountedAt?: Date | null;
  /**
   * Promotion back-reference. Null = manual free-form discount; set =
   * discount was sourced from an applied Promotion (auto or manual opt-in).
   * Defaults to null so existing manual-discount call sites remain unchanged.
   */
  promotionId?: string | null;
}

export interface ApplySaleItemDiscountInput {
  type: 'amount' | 'percentage';
  amountCents?: number;
  percent?: number;
  discountTitle?: string;
  strategy?: 'replace' | 'skip';
  /**
   * Promotion back-reference (Unit 3+). When set, the discount is tagged as
   * promo-sourced; when omitted, the discount is treated as a manual
   * free-form override. Default: null (manual).
   */
  promotionId?: string | null;
}

/**
 * Input for `SaleItem.applyBuyXGetYReward` (BUY_X_GET_Y whole-line cents
 * reward — design.md Decision 1; spec.md:97-106).
 *
 * The BXGY path is a SEPARATE method from `applyDiscount` and BYPASSES the
 * per-unit clamp (sale-item.entity.ts:267 — `baseline − discount >= 1`) so a
 * get-unit can surface at 0c (true free, getDiscountPercent=100). The
 * per-unit `applyDiscount` percentage clamp (1..99) and the
 * `baseline − discount >= 1` invariant are NOT on the BXGY path —
 * `applyDiscount`'s contract is unchanged (zero PRODUCT_DISCOUNT regression
 * surface, locked by spec.md:93-95).
 *
 * `unitPriceCents` stays FULL (the buy-price); `prePriceCentsBeforeDiscount`
 * is set EQUAL to `unitPriceCents` — that EQUAL is the discriminator
 * `isBuyXGetYReward()` reads.
 */
export interface ApplyBuyXGetYRewardInput {
  /** R — whole-line cents reward (the line subtotal drop). */
  lineDiscountCents: number;
  /** Snapshot of the per-unit reward for the receipt wire field. */
  perUnitRewardCents: number;
  /** Snapshot of the discounted-unit count (groups * M) for the receipt. */
  discountedUnitCount: number;
  /** Optional human-readable label (e.g. "Buy 2 Get 1 @ 50%"). */
  discountTitle?: string;
  /** BXGY promotion id (drives the discriminator + cross-line retention). */
  promotionId: string;
}

export interface OverrideSaleItemPriceInput {
  priceCents: number;
  priceSource: 'price_list' | 'custom';
  appliedPriceListId: string | null;
  customPriceCents: number | null;
}

/**
 * SaleItem Entity - represents a line item in a POS sale
 *
 * Business rules:
 * - Quantity must be >= 1
 * - Unit price must be >= 0
 * - Price is frozen at add-time (snapshot from product/variant)
 * - Items are identified by product+variant combination for stacking
 */
export class SaleItem {
  private constructor(
    public readonly id: string,
    public readonly saleId: string,
    public readonly productId: string,
    public readonly variantId: string | null,
    public readonly productName: string,
    public readonly variantName: string | null,
    public readonly imageUrl: string | null,
    private _quantity: number,
    private _unitPriceCents: number,
    public readonly unitPriceCurrency: string,
    private _originalPriceCents: number | null,
    private _priceSource: 'default' | 'price_list' | 'custom',
    private _appliedPriceListId: string | null,
    private _customPriceCents: number | null,
    private _discountType: 'amount' | 'percentage' | null,
    private _discountValue: number | null,
    private _discountAmountCents: number | null,
    private _prePriceCentsBeforeDiscount: number | null,
    private _discountTitle: string | null,
    private _discountedAt: Date | null,
    private _promotionId: string | null,
  ) {}

  static create(props: SaleItemProps): SaleItem {
    // Validate required fields
    if (!props.productId || props.productId.trim() === '') {
      throw new InvalidArgumentError('Product ID cannot be empty');
    }
    if (!props.productName || props.productName.trim() === '') {
      throw new InvalidArgumentError('Product name cannot be empty');
    }

    // Validate quantity
    if (props.quantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }

    // Validate price
    if (props.unitPriceCents < 0) {
      throw new InvalidArgumentError('Unit price cannot be negative');
    }

    return new SaleItem(
      props.id,
      props.saleId,
      props.productId,
      props.variantId,
      props.productName,
      props.variantName,
      props.imageUrl ?? null,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency,
      props.originalPriceCents ?? null,
      props.priceSource ?? 'default',
      props.appliedPriceListId ?? null,
      props.customPriceCents ?? null,
      props.discountType ?? null,
      props.discountValue ?? null,
      props.discountAmountCents ?? null,
      props.prePriceCentsBeforeDiscount ?? null,
      props.discountTitle ?? null,
      props.discountedAt ?? null,
      props.promotionId ?? null,
    );
  }

  static fromPersistence(props: SaleItemProps): SaleItem {
    return new SaleItem(
      props.id,
      props.saleId,
      props.productId,
      props.variantId,
      props.productName,
      props.variantName,
      props.imageUrl ?? null,
      props.quantity,
      props.unitPriceCents,
      props.unitPriceCurrency,
      props.originalPriceCents ?? null,
      props.priceSource ?? 'default',
      props.appliedPriceListId ?? null,
      props.customPriceCents ?? null,
      props.discountType ?? null,
      props.discountValue ?? null,
      props.discountAmountCents ?? null,
      props.prePriceCentsBeforeDiscount ?? null,
      props.discountTitle ?? null,
      props.discountedAt ?? null,
      props.promotionId ?? null,
    );
  }

  get quantity(): number {
    return this._quantity;
  }

  get unitPriceCents(): number {
    return this._unitPriceCents;
  }

  get subtotalCents(): number {
    return this._unitPriceCents * this._quantity;
  }

  get originalPriceCents(): number | null {
    return this._originalPriceCents;
  }

  get priceSource(): 'default' | 'price_list' | 'custom' {
    return this._priceSource;
  }

  get appliedPriceListId(): string | null {
    return this._appliedPriceListId;
  }

  get customPriceCents(): number | null {
    return this._customPriceCents;
  }

  get discountType(): 'amount' | 'percentage' | null {
    return this._discountType;
  }

  get discountValue(): number | null {
    return this._discountValue;
  }

  get discountAmountCents(): number | null {
    return this._discountAmountCents;
  }

  get prePriceCentsBeforeDiscount(): number | null {
    return this._prePriceCentsBeforeDiscount;
  }

  get discountTitle(): string | null {
    return this._discountTitle;
  }

  get discountedAt(): Date | null {
    return this._discountedAt;
  }

  get promotionId(): string | null {
    return this._promotionId;
  }

  changeQuantity(newQuantity: number): void {
    if (newQuantity < 1) {
      throw new InvalidArgumentError('Quantity must be at least 1');
    }
    this._quantity = newQuantity;
  }

  matches(productId: string, variantId: string | null): boolean {
    return this.productId === productId && this.variantId === variantId;
  }

  overridePrice(input: OverrideSaleItemPriceInput): void {
    if (input.priceSource === 'price_list') {
      if (!input.appliedPriceListId || input.customPriceCents !== null) {
        throw new InvalidArgumentError('INVALID_PRICE_OVERRIDE_INPUT');
      }
    }

    if (input.priceSource === 'custom') {
      if (!input.customPriceCents || input.appliedPriceListId !== null) {
        throw new InvalidArgumentError('INVALID_PRICE_OVERRIDE_INPUT');
      }
    }

    if (this._originalPriceCents === null) {
      this._originalPriceCents = this._unitPriceCents;
    }

    this._unitPriceCents = input.priceCents;
    this._priceSource = input.priceSource;
    this._appliedPriceListId = input.appliedPriceListId;
    this._customPriceCents = input.customPriceCents;
    this.clearDiscountFields();
  }

  applyDiscount(input: ApplySaleItemDiscountInput): void {
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

    const baseline = this._prePriceCentsBeforeDiscount ?? this._unitPriceCents;
    const discountAmountCents = this.computeDiscountAmountCents(
      input,
      baseline,
    );
    if (baseline - discountAmountCents < 1) {
      throw new InvalidArgumentError('DISCOUNT_AMOUNT_INVALID');
    }

    this._prePriceCentsBeforeDiscount = baseline;
    this._discountType = input.type;
    this._discountValue =
      input.type === 'amount' ? input.amountCents! : input.percent!;
    this._discountAmountCents = discountAmountCents;
    this._discountTitle = input.discountTitle ?? null;
    this._discountedAt = new Date();
    this._unitPriceCents = baseline - discountAmountCents;
    // Tag the discount as promo-sourced when input.promotionId is provided;
    // null = manual free-form discount (existing call sites unchanged).
    this._promotionId = input.promotionId ?? null;
  }

  removeDiscount(): void {
    if (this._prePriceCentsBeforeDiscount !== null) {
      this._unitPriceCents = this._prePriceCentsBeforeDiscount;
    }
    this.clearDiscountFields();
  }

  /**
   * Apply a BUY_X_GET_Y whole-line cents reward `R` (design.md Decision 1;
   * spec.md:97-106). Bypasses `applyDiscount`'s per-unit clamp so a
   * get-unit can surface at 0c (true free, getDiscountPercent=100).
   *
   * Contract (locked by WU2 unit tests):
   *   - `unitPriceCents` stays FULL — never mutated.
   *   - `prePriceCentsBeforeDiscount = unitPriceCents` (EQUAL — the
   *     discriminator).
   *   - `discountAmountCents = R` (whole-line, NOT per-unit).
   *   - `discountValue` snapshots the per-unit reward for the receipt.
   *   - `discountType = 'amount'` (rides the existing enum value).
   *   - `discountTitle`, `discountedAt`, `promotionId` set.
   *
   * Guard: `R` integer, `0 < R < unitPriceCents × quantity` (cannot reward
   * more than the line subtotal, cannot reward zero or negative).
   */
  applyBuyXGetYReward(input: ApplyBuyXGetYRewardInput): void {
    if (
      !Number.isInteger(input.lineDiscountCents) ||
      input.lineDiscountCents <= 0
    ) {
      throw new InvalidArgumentError(
        'BXGY_REWARD_INVALID: lineDiscountCents must be a positive integer',
      );
    }
    if (input.lineDiscountCents >= this._unitPriceCents * this._quantity) {
      throw new InvalidArgumentError(
        'BXGY_REWARD_INVALID: lineDiscountCents must be less than unitPriceCents * quantity',
      );
    }
    if (!input.promotionId) {
      throw new InvalidArgumentError(
        'BXGY_REWARD_INVALID: promotionId is required',
      );
    }

    // Snapshot the buy-price as the pre-discount base. BXGY never mutates
    // `_unitPriceCents` — the EQUAL invariant `unitPrice === prePrice` is
    // the column-derived discriminator `isBuyXGetYReward()`.
    this._prePriceCentsBeforeDiscount = this._unitPriceCents;
    this._discountType = 'amount';
    this._discountValue = input.perUnitRewardCents;
    this._discountAmountCents = input.lineDiscountCents;
    this._discountTitle = input.discountTitle ?? null;
    this._discountedAt = new Date();
    this._promotionId = input.promotionId;
  }

  /**
   * Column-derived BXGY discriminator (design.md Decision 1). Reads the
   * same persisted columns the receipt/detail mapper reconstructs (see
   * `prisma-sale.repository.ts:1392-1393`) so both readers compute NET
   * identically — domain path (previewTotals) and wire path (mapper).
   *
   * Returns true iff:
   *   - `promotionId` is set (promo-sourced, not manual free-form), AND
   *   - `discountAmountCents > 0` (a reward exists), AND
   *   - `prePriceCentsBeforeDiscount` is set (snapshot taken), AND
   *   - `unitPriceCents === prePriceCentsBeforeDiscount` (BXGY never
   *     mutated the unit price — the per-unit `applyDiscount` path always
   *     forces `unitPrice < prePrice` by ≥1 via sale-item.entity.ts:267).
   *
   * This discriminator is unreachable by the per-unit path by invariant;
   * a per-unit PD line fails the last clause.
   */
  isBuyXGetYReward(): boolean {
    return (
      this._promotionId !== null &&
      this._discountAmountCents !== null &&
      this._discountAmountCents > 0 &&
      this._prePriceCentsBeforeDiscount !== null &&
      this._unitPriceCents === this._prePriceCentsBeforeDiscount
    );
  }

  private computeDiscountAmountCents(
    input: ApplySaleItemDiscountInput,
    baseline: number,
  ): number {
    if (input.type === 'amount') {
      if (!Number.isInteger(input.amountCents) || input.amountCents! < 1) {
        throw new InvalidArgumentError('DISCOUNT_AMOUNT_INVALID');
      }
      return input.amountCents!;
    }

    if (
      !Number.isInteger(input.percent) ||
      input.percent! < 1 ||
      input.percent! > 99
    ) {
      throw new InvalidArgumentError('DISCOUNT_PERCENT_INVALID');
    }
    return Math.round((baseline * input.percent!) / 100);
  }

  private clearDiscountFields(): void {
    this._discountType = null;
    this._discountValue = null;
    this._discountAmountCents = null;
    this._prePriceCentsBeforeDiscount = null;
    this._discountTitle = null;
    this._discountedAt = null;
    this._promotionId = null;
  }

  toResponse() {
    return {
      id: this.id,
      productId: this.productId,
      variantId: this.variantId,
      productName: this.productName,
      variantName: this.variantName,
      imageUrl: this.imageUrl,
      quantity: this.quantity,
      unitPriceCents: this.unitPriceCents,
      unitPriceCurrency: this.unitPriceCurrency,
      originalPriceCents: this.originalPriceCents,
      priceSource: this.priceSource,
      appliedPriceListId: this.appliedPriceListId,
      customPriceCents: this.customPriceCents,
      discountType: this.discountType,
      discountValue: this.discountValue,
      discountAmountCents: this.discountAmountCents,
      prePriceCentsBeforeDiscount: this.prePriceCentsBeforeDiscount,
      discountTitle: this.discountTitle,
      discountedAt: this.discountedAt,
      promotionId: this.promotionId,
    };
  }
}
