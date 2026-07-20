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
  /**
   * Exact BUY_X_GET_Y `getDiscountPercent` (0..100) snapshot. Null on
   * non-reward lines. Restored on reload so a confirmed sale entity carries
   * the same percent it was persisted with.
   */
  rewardDiscountPercent?: number | null;
  /**
   * Slice 2 / WU5 — D4 wire discriminator. Read from the new
   * `SaleItem.rewardKind` column. Lowercase wire value: 'buy_x_get_y' |
   * 'advanced' | null. The receipt mapper (prisma-sale.repository.ts:1420)
   * persists uppercase Prisma enum values and the entity accepts both
   * shapes on round-trip — see `fromPersistence` below.
   */
  rewardKind?: 'buy_x_get_y' | 'advanced' | null;
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
  /**
   * Exact `getDiscountPercent` (0..100; 100=free, 50=half) of the applied
   * BUY_X_GET_Y promotion. Stored verbatim (never derived from cents) so the
   * reward line can expose the true percent end-to-end.
   */
  getDiscountPercent: number;
  /**
   * Slice 2 / WU5 — D4 wire discriminator. Defaults to `'buy_x_get_y'` when
   * omitted, preserving the BXGY contract for every existing call site
   * (sales.service.ts:515 was the only pre-Slice-2 caller and it does not
   * pass the field). Pass `'advanced'` for ADVANCED-kind engine results
   * (sales.service.ts:515 WU6 close-out) so the wire emits
   * `rewardKind: 'advanced'` — the Slice 1 stub at sales.service.ts:515-525
   * silently relabeled ADVANCED as BXGY without this field.
   */
  rewardKind?: 'buy_x_get_y' | 'advanced';
}

export interface OverrideSaleItemPriceInput {
  priceCents: number;
  priceSource: 'price_list' | 'custom';
  appliedPriceListId: string | null;
  customPriceCents: number | null;
}

/**
 * Input for `SaleItem.reprice` (POS Price List Tiers — WU1). Distinct
 * from `OverrideSaleItemPriceInput`: `reprice` is engine-driven tier
 * re-resolution on non-sticky lines (addItem / updateItemQuantity /
 * sale-list switch) and MUST NOT snapshot `_originalPriceCents` or clear
 * any discount field — those side-effects belong to `overridePrice`. The
 * `priceSource` is therefore restricted to `'default' | 'price_list'`;
 * `'custom'` would mark the line sticky and is rejected here.
 */
export interface RepriceSaleItemInput {
  priceCents: number;
  /** `'custom'` is accepted for type-safety but MUST throw at runtime —
   *  callers route sticky lines through `overridePrice()`, never `reprice()`. */
  priceSource: 'default' | 'price_list' | 'custom';
  appliedPriceListId: string | null;
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
  /**
   * Exact BUY_X_GET_Y `getDiscountPercent` (0..100; 100=free, 50=half) of the
   * applied promotion. Null on non-reward lines — mirrors `rewardKind`
   * exactly. Set by `applyBuyXGetYReward`, cleared by `clearDiscountFields`.
   */
  private _rewardDiscountPercent: number | null = null;
  /**
   * Slice 2 / WU5 — D4 wire discriminator (design.md Decision 4; spec.md
   * MODIFIED Requirement: `rewardKind: 'advanced'` Wire Discriminator).
   * The column-derived `isBuyXGetYReward()` predicate is byte-identical for
   * BUY_X_GET_Y and ADVANCED lines (both reuse the same
   * `prePriceCentsBeforeDiscount === unitPriceCents + promotionId set +
   * discountAmountCents > 0` shape), so the engine CANNOT distinguish the
   * two without a persisted discriminator. This field is set by
   * `applyBuyXGetYReward({ ..., rewardKind })` and round-tripped by
   * `fromPersistence({ ..., rewardKind })`. Default on call sites that
   * don't pass the new field is `'buy_x_get_y'` (back-compat for every
   * existing BXGY caller). Null on non-reward lines — mirrors
   * `_rewardDiscountPercent` exactly.
   */
  private _rewardKind: 'buy_x_get_y' | 'advanced' | null = null;

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
    const item = new SaleItem(
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
    item._rewardDiscountPercent = props.rewardDiscountPercent ?? null;
    // WU5 — round-trip the persisted D4 discriminator. The receipt mapper
    // already passes the lowercase wire shape (`'buy_x_get_y' | 'advanced'`)
    // directly, so no enum coercion is needed here; the field is null on
    // non-reward rows.
    item._rewardKind = props.rewardKind ?? null;
    return item;
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

  get rewardDiscountPercent(): number | null {
    return this._rewardDiscountPercent;
  }

  /**
   * Slice 2 / WU5 — D4 wire discriminator. Returns the persisted
   * `rewardKind` value when one is set (BXGY/ADVANCED); null otherwise
   * (non-reward lines: per-unit PD, manual free-form, plain).
   *
   * Surfaced on the wire via `toResponse().rewardKind`. Read by the
   * confirmed-sale receipt mapper after a persistence round-trip; written
   * by `applyBuyXGetYReward({ ..., rewardKind })` and persisted via the
   * new `SaleItem.rewardKind` column (additive migration; see
   * prisma/migrations/<ts>_add_sale_item_reward_kind/migration.sql).
   */
  get rewardKind(): 'buy_x_get_y' | 'advanced' | null {
    return this._rewardKind;
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

  /**
   * WU1 — `reprice` is the engine-driven tier re-resolver on non-sticky
   * lines (addItem / updateItemQuantity / sale-list switch). Mutates
   * `_unitPriceCents` + `_priceSource` + optional `_appliedPriceListId`
   * only — NEVER snapshots `_originalPriceCents`, NEVER touches discount
   * fields. The `priceSource` is restricted to `'default' | 'price_list'`;
   * `'custom'` is rejected because marking a line sticky is
   * `overridePrice`'s contract.
   */
  reprice(input: RepriceSaleItemInput): void {
    if (input.priceSource === 'custom') {
      throw new InvalidArgumentError('INVALID_REPRICE_INPUT');
    }
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw new InvalidArgumentError('INVALID_REPRICE_INPUT');
    }

    this._unitPriceCents = input.priceCents;
    this._priceSource = input.priceSource;
    this._appliedPriceListId = input.appliedPriceListId;
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
   * Guard: `R` integer, `0 < R <= unitPriceCents × quantity` (cannot reward
   * more than the line subtotal, cannot reward zero or negative). The
   * upper bound is `<=` (not `<`) because a 100% ADVANCED reward on a
   * full-line free scenario legitimately yields R == unitPriceCents ×
   * quantity (true free). Equality is the edge of the over-reward
   * invariant: BXGY structurally cannot reach it (the helper caps at
   * floor(qty/(N+M)) × M × perUnit < qty × unitPrice), so relaxing the
   * guard does not widen BXGY behavior — it only admits the legitimate
   * full-free ADVANCED edge case that previously 500'd the POS add-item
   * (D3 / 4R-review).
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
    if (input.lineDiscountCents > this._unitPriceCents * this._quantity) {
      throw new InvalidArgumentError(
        'BXGY_REWARD_INVALID: lineDiscountCents must be at most unitPriceCents * quantity',
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
    // Exact promo percent — carried verbatim, never derived from cents.
    this._rewardDiscountPercent = input.getDiscountPercent ?? null;
    // WU5 — D4 wire discriminator. Defaults to 'buy_x_get_y' for back-
    // compat with every pre-Slice-2 BXGY call site that does not pass the
    // new field. WU6 closes the sales.service.ts:515-525 Slice-1 stub by
    // passing `rewardKind: 'advanced'` on the ADVANCED arm so the wire
    // stops silently relabeling ADVANCED as BXGY.
    this._rewardKind = input.rewardKind ?? 'buy_x_get_y';
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
    // Cleared alongside the reward state — mirrors rewardKind reset.
    this._rewardDiscountPercent = null;
    // WU5 — clear the D4 discriminator too. recompute clear/apply relies on
    // this: a stale rewardKind would mislabel a non-reward line as
    // BXGY/ADVANCED on the next toResponse() read.
    this._rewardKind = null;
  }

  toResponse() {
    // Work Unit 8 — Draft NET per-line subtotal + rewardKind wire contract.
    // The DRAFT surface (addItem / updateItemQuantity / previewTotals / etc.)
    // used to emit gross `subtotalCents` and no `rewardKind`, so the POS
    // /wiz-pos frontend rendered BXGY lines as gross. The confirmed-sale
    // receipt mapper already exposes both keys (see prisma-sale.repository.ts:
    // 1407, 1421-1422, 1437); this closes the contract gap so the frontend
    // reads the SAME field on both surfaces.
    //
    // Formula mirrors the receipt mapper exactly:
    //   subtotalCents = unitPriceCents * quantity
    //                   - (isBuyXGetYReward() ? (discountAmountCents ?? 0) : 0)
    //   rewardKind    = this._rewardKind
    //                   ?? (isBuyXGetYReward() ? 'buy_x_get_y' : null)
    //
    // Per-unit PRODUCT_DISCOUNT path keeps `unitPrice < prePrice` so
    // `isBuyXGetYReward()` returns false → R = 0 → no subtraction (the
    // per-unit subtotal is already NET because `applyDiscount` reduced
    // `unitPriceCents`). Manual free-form discounts fail the discriminator's
    // first clause (promotionId null) and the same logic applies. Plain
    // lines return gross = NET.
    //
    // WU5 — the new `_rewardKind` is the authoritative source. The
    // `isBuyXGetYReward()` column-derived fallback ONLY fires when the
    // discriminator is not set (call site did not pass it AND the entity
    // was not reloaded from persistence). In the persisted path (receipt
    // mapper), the mapper passes `rewardKind` explicitly so the wire
    // surfaces the column value verbatim — no fallback is taken.
    //
    // NOTE: `subtotalCents` here is intentionally a NEW field on the
    // returned wire object and DOES NOT touch the existing
    // `get subtotalCents()` getter at :194-196, which still returns the
    // gross value for previewTotals and other in-domain consumers. The
    // emitted-key naming was chosen because both the receipt mapper and the
    // draft-surface need a uniform wire-side NET field; renaming the getter
    // would break every previewTotals call site.
    const isBxgy = this.isBuyXGetYReward();
    const bxgyRewardCents = isBxgy ? (this.discountAmountCents ?? 0) : 0;
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
      // NET per-line subtotal — see formula in the block comment above.
      subtotalCents: this._unitPriceCents * this._quantity - bxgyRewardCents,
      // WU5 — D4 wire discriminator. Authoritative source is `_rewardKind`;
      // the column-derived `isBxgy` predicate is the back-compat fallback
      // (only fires for the rare in-memory call site that did not pass
      // `rewardKind` and was not reloaded from persistence). For ADVANCED
      // rows the column-derived check returns true (same shape as BXGY),
      // but `_rewardKind = 'advanced'` wins — so the wire is NEVER silently
      // relabeled as BXGY (the Slice 1 stub bug).
      rewardKind: this._rewardKind ?? (isBxgy ? 'buy_x_get_y' : null),
      // Exact BXGY reward percent (0..100). Null on non-reward lines — same
      // `isBxgy` guard as `rewardKind`. Lets the frontend show "GRATIS" only
      // at 100%, otherwise the real percent.
      rewardDiscountPercent: isBxgy ? this._rewardDiscountPercent : null,
    };
  }
}
