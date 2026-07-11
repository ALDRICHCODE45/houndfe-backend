import { InvalidArgumentError } from '../../shared/domain/domain-error';

// ============================================================
// Type aliases (mirror Prisma enums)
// ============================================================
export type PromotionType =
  | 'PRODUCT_DISCOUNT'
  | 'ORDER_DISCOUNT'
  | 'BUY_X_GET_Y'
  | 'ADVANCED';

export type PromotionMethod = 'AUTOMATIC' | 'MANUAL';
export type PromotionStatus = 'ACTIVE' | 'SCHEDULED' | 'ENDED';
export type DiscountType = 'PERCENTAGE' | 'FIXED';
export type PromotionTargetType = 'CATEGORIES' | 'BRANDS' | 'PRODUCTS';
export type CustomerScope = 'ALL' | 'REGISTERED_ONLY' | 'SPECIFIC';
export type DayOfWeek =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';
export type TargetSide = 'DEFAULT' | 'BUY' | 'GET';

// ============================================================
// Relation shapes (for hydration from DB)
// ============================================================
export interface PromotionTargetItemData {
  id: string;
  side: TargetSide;
  targetType: PromotionTargetType;
  targetId: string;
}

export interface PromotionCustomerData {
  id: string;
  customerId: string;
  customer?: { id: string; firstName: string; lastName: string | null } | null;
}

export interface PromotionPriceListData {
  id: string;
  globalPriceListId: string;
  globalPriceList?: { id: string; name: string } | null;
}

export interface PromotionDayOfWeekData {
  id: string;
  day: DayOfWeek;
}

// ============================================================
// Props interface (internal entity state)
// ============================================================
export interface PromotionProps {
  id: string;
  title: string;
  type: PromotionType;
  method: PromotionMethod;
  status: PromotionStatus;
  /**
   * Operator-initiated ENDED (set via `Promotion.end()`). Distinct from the
   * `status` column: `manuallyEnded` is a permanent override honoured by
   * `getEffectiveStatus()` at READ time, while the `status` column is a
   * write-through hint that can become stale when dates change.
   *
   * Optional in `PromotionProps` for backward compatibility with existing
   * fixtures / call sites that pre-date the column. `fromPersistence()`
   * defaults to `false` so the entity invariant always holds.
   */
  manuallyEnded?: boolean;
  startDate: Date | null;
  endDate: Date | null;
  customerScope: CustomerScope;
  discountType: DiscountType | null;
  discountValue: number | null;
  minPurchaseAmountCents: number | null;
  appliesTo: PromotionTargetType | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  getDiscountPercent: number | null;
  buyTargetType: PromotionTargetType | null;
  getTargetType: PromotionTargetType | null;
  createdAt: Date;
  updatedAt: Date;
  // Relations (populated from persistence)
  targetItems: PromotionTargetItemData[];
  customers: PromotionCustomerData[];
  priceLists: PromotionPriceListData[];
  daysOfWeek: PromotionDayOfWeekData[];
}

// ============================================================
// Create params (input to static create())
// ============================================================
export interface CreatePromotionParams {
  id: string;
  title: string;
  type: PromotionType;
  method: PromotionMethod;
  manuallyEnded?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  customerScope?: CustomerScope;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  minPurchaseAmountCents?: number | null;
  appliesTo?: PromotionTargetType | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  getDiscountPercent?: number | null;
  buyTargetType?: PromotionTargetType | null;
  getTargetType?: PromotionTargetType | null;
}

// ============================================================
// Pure validation helpers
// ============================================================

function requireField<T>(
  value: T | null | undefined,
  fieldName: string,
  typeName: string,
): T {
  if (value === null || value === undefined) {
    throw new InvalidArgumentError(
      `${fieldName} is required for ${typeName} type`,
      'MISSING_REQUIRED_FIELD',
    );
  }
  return value;
}

function forbidField(
  value: unknown,
  fieldName: string,
  typeName: string,
): void {
  if (value !== null && value !== undefined) {
    throw new InvalidArgumentError(
      `${fieldName} is not allowed for ${typeName} type`,
      'FORBIDDEN_FIELD',
    );
  }
}

function validateDiscountValue(
  discountType: DiscountType,
  discountValue: number,
): void {
  if (discountType === 'PERCENTAGE') {
    if (discountValue < 1 || discountValue > 100) {
      throw new InvalidArgumentError(
        'discountValue must be between 1 and 100 for PERCENTAGE type',
        'INVALID_FIELD_VALUE',
      );
    }
  } else {
    // FIXED
    if (discountValue <= 0) {
      throw new InvalidArgumentError(
        'discountValue must be greater than 0 for FIXED type',
        'INVALID_FIELD_VALUE',
      );
    }
  }
}

function validateQuantityField(value: number, fieldName: string): void {
  if (value < 1) {
    throw new InvalidArgumentError(
      `${fieldName} must be >= 1`,
      'INVALID_FIELD_VALUE',
    );
  }
}

function validateGetDiscountPercent(value: number): void {
  if (value < 0 || value > 99) {
    throw new InvalidArgumentError(
      'getDiscountPercent must be between 0 and 99',
      'INVALID_FIELD_VALUE',
    );
  }
}

function validateDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
): void {
  if (startDate && endDate && endDate < startDate) {
    throw new InvalidArgumentError(
      'endDate must be >= startDate',
      'INVALID_DATE_RANGE',
    );
  }
}

/**
 * Derive status from dates alone. Used as a write-through hint for the
 * `status` column and as a building block for `getEffectiveStatus()`.
 *
 * `manuallyEnded` is NOT consulted here — that flag lives outside the
 * date-window semantics and is honoured only at READ time by
 * `getEffectiveStatus()`. This keeps the derivation pure and testable.
 */
function deriveStatus(
  startDate: Date | null,
  endDate: Date | null,
  now: Date = new Date(),
): PromotionStatus {
  if (endDate && endDate < now) return 'ENDED';
  if (startDate && startDate > now) return 'SCHEDULED';
  return 'ACTIVE';
}

// ============================================================
// Entity
// ============================================================
export class Promotion {
  public readonly id: string;
  public title: string;
  public readonly type: PromotionType;
  public readonly method: PromotionMethod;
  public status: PromotionStatus;
  /**
   * Operator-initiated ENDED. Permanent until an explicit re-activation.
   * Honoured by `getEffectiveStatus()` regardless of the (possibly stale)
   * `status` column or the current date window.
   */
  public manuallyEnded: boolean;
  public startDate: Date | null;
  public endDate: Date | null;
  public customerScope: CustomerScope;
  public discountType: DiscountType | null;
  public discountValue: number | null;
  public minPurchaseAmountCents: number | null;
  public appliesTo: PromotionTargetType | null;
  public buyQuantity: number | null;
  public getQuantity: number | null;
  public getDiscountPercent: number | null;
  public buyTargetType: PromotionTargetType | null;
  public getTargetType: PromotionTargetType | null;
  public readonly createdAt: Date;
  public updatedAt: Date;
  public targetItems: PromotionTargetItemData[];
  public customers: PromotionCustomerData[];
  public priceLists: PromotionPriceListData[];
  public daysOfWeek: PromotionDayOfWeekData[];

  private constructor(props: PromotionProps) {
    this.id = props.id;
    this.title = props.title;
    this.type = props.type;
    this.method = props.method;
    this.status = props.status;
    this.manuallyEnded = props.manuallyEnded ?? false;
    this.startDate = props.startDate;
    this.endDate = props.endDate;
    this.customerScope = props.customerScope;
    this.discountType = props.discountType;
    this.discountValue = props.discountValue;
    this.minPurchaseAmountCents = props.minPurchaseAmountCents;
    this.appliesTo = props.appliesTo;
    this.buyQuantity = props.buyQuantity;
    this.getQuantity = props.getQuantity;
    this.getDiscountPercent = props.getDiscountPercent;
    this.buyTargetType = props.buyTargetType;
    this.getTargetType = props.getTargetType;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.targetItems = props.targetItems;
    this.customers = props.customers;
    this.priceLists = props.priceLists;
    this.daysOfWeek = props.daysOfWeek;
  }

  // ============================================================
  // Static create — validates type-specific rules
  // ============================================================
  static create(params: CreatePromotionParams): Promotion {
    const title = params.title?.trim();
    if (!title) {
      throw new InvalidArgumentError(
        'Promotion title is required',
        'MISSING_REQUIRED_FIELD',
      );
    }

    const startDate = params.startDate ?? null;
    const endDate = params.endDate ?? null;
    validateDateRange(startDate, endDate);

    // Type-specific validation
    validateByType(params);

    const now = new Date();
    const manuallyEnded = params.manuallyEnded ?? false;
    return new Promotion({
      id: params.id,
      title,
      type: params.type,
      method: params.method,
      // Persisted column = the date-derived hint. If the operator has
      // manually ended, reflect that immediately so list filtering works
      // even before the row is re-fetched from the DB.
      status: manuallyEnded ? 'ENDED' : deriveStatus(startDate, endDate, now),
      manuallyEnded,
      startDate,
      endDate,
      customerScope: params.customerScope ?? 'ALL',
      discountType: params.discountType ?? null,
      discountValue: params.discountValue ?? null,
      minPurchaseAmountCents: params.minPurchaseAmountCents ?? null,
      appliesTo: params.appliesTo ?? null,
      buyQuantity: params.buyQuantity ?? null,
      getQuantity: params.getQuantity ?? null,
      getDiscountPercent: params.getDiscountPercent ?? null,
      buyTargetType: params.buyTargetType ?? null,
      getTargetType: params.getTargetType ?? null,
      createdAt: now,
      updatedAt: now,
      targetItems: [],
      customers: [],
      priceLists: [],
      daysOfWeek: [],
    });
  }

  // ============================================================
  // fromPersistence — no validation, just hydration
  // ============================================================
  static fromPersistence(data: PromotionProps): Promotion {
    return new Promotion({
      ...data,
      // Default the manual flag to false so legacy callers / tests that
      // construct PromotionProps without the new field keep working.
      manuallyEnded: data.manuallyEnded ?? false,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    });
  }

  // ============================================================
  // getEffectiveStatus — READ-TIME single source of truth.
  //
  // Decision contract:
  //   1. manuallyEnded is the ONLY permanent override (operator intent).
  //   2. Otherwise the status is derived from the current date window,
  //      ALWAYS — the persisted `status` column is treated as a stale
  //      write-through hint and is NEVER trusted to force ENDED.
  //   3. Bounds are inclusive: at exactly endDate the promotion is still
  //      ACTIVE / eligible (matches the POS engine invariant).
  // ============================================================
  getEffectiveStatus(now: Date): PromotionStatus {
    if (this.manuallyEnded) return 'ENDED';

    if (this.startDate && this.startDate > now) return 'SCHEDULED';
    if (this.endDate && this.endDate < now) return 'ENDED';
    return 'ACTIVE';
  }

  // ============================================================
  // end() — irreversibly end the promotion (operator intent).
  // Sets both the manual override flag and the persisted status column
  // so list-filter queries continue to match this row without read-time
  // recomputation.
  // ============================================================
  end(): void {
    if (this.manuallyEnded) return; // idempotent
    this.manuallyEnded = true;
    this.status = 'ENDED';
    if (!this.endDate) {
      this.endDate = new Date();
    }
    this.updatedAt = new Date();
  }

  // ============================================================
  // recomputeStatus — write-time status sync.
  // Service calls this on every update() so the persisted `status`
  // column reflects the current date window. Manually-ended rows stay
  // ENDED; the manual flag is never silently cleared by this method.
  // ============================================================
  recomputeStatus(now: Date = new Date()): void {
    this.status = this.getEffectiveStatus(now);
  }

  // ============================================================
  // toResponse — public API shape
  // ============================================================
  toResponse(now?: Date): Record<string, unknown> {
    const effectiveNow = now ?? new Date();
    return {
      id: this.id,
      title: this.title,
      type: this.type,
      method: this.method,
      status: this.getEffectiveStatus(effectiveNow),
      startDate: this.startDate?.toISOString() ?? null,
      endDate: this.endDate?.toISOString() ?? null,
      customerScope: this.customerScope,
      discountType: this.discountType,
      discountValue: this.discountValue,
      minPurchaseAmountCents: this.minPurchaseAmountCents,
      appliesTo: this.appliesTo,
      buyQuantity: this.buyQuantity,
      getQuantity: this.getQuantity,
      getDiscountPercent: this.getDiscountPercent,
      buyTargetType: this.buyTargetType,
      getTargetType: this.getTargetType,
      targetItems: this.targetItems,
      customers: this.customers,
      priceLists: this.priceLists,
      daysOfWeek: this.daysOfWeek,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}

// ============================================================
// Type-specific validation (pure function — extracted for testability)
// ============================================================
function validateByType(params: CreatePromotionParams): void {
  const type = params.type;

  switch (type) {
    case 'PRODUCT_DISCOUNT': {
      requireField(params.discountType, 'discountType', type);
      requireField(params.discountValue, 'discountValue', type);
      requireField(params.appliesTo, 'appliesTo', type);
      validateDiscountValue(params.discountType!, params.discountValue!);
      // Forbidden fields
      forbidField(params.buyQuantity, 'buyQuantity', type);
      forbidField(params.getQuantity, 'getQuantity', type);
      forbidField(params.getDiscountPercent, 'getDiscountPercent', type);
      forbidField(
        params.minPurchaseAmountCents,
        'minPurchaseAmountCents',
        type,
      );
      forbidField(params.buyTargetType, 'buyTargetType', type);
      forbidField(params.getTargetType, 'getTargetType', type);
      break;
    }
    case 'ORDER_DISCOUNT': {
      requireField(params.discountType, 'discountType', type);
      requireField(params.discountValue, 'discountValue', type);
      validateDiscountValue(params.discountType!, params.discountValue!);
      // Forbidden fields
      forbidField(params.appliesTo, 'appliesTo', type);
      forbidField(params.buyQuantity, 'buyQuantity', type);
      forbidField(params.getQuantity, 'getQuantity', type);
      forbidField(params.getDiscountPercent, 'getDiscountPercent', type);
      forbidField(params.buyTargetType, 'buyTargetType', type);
      forbidField(params.getTargetType, 'getTargetType', type);
      break;
    }
    case 'BUY_X_GET_Y': {
      requireField(params.buyQuantity, 'buyQuantity', type);
      requireField(params.getQuantity, 'getQuantity', type);
      const gdp = requireField(
        params.getDiscountPercent,
        'getDiscountPercent',
        type,
      );
      validateQuantityField(params.buyQuantity!, 'buyQuantity');
      validateQuantityField(params.getQuantity!, 'getQuantity');
      validateGetDiscountPercent(gdp);
      // Forbidden fields
      forbidField(params.discountType, 'discountType', type);
      forbidField(params.discountValue, 'discountValue', type);
      forbidField(
        params.minPurchaseAmountCents,
        'minPurchaseAmountCents',
        type,
      );
      forbidField(params.buyTargetType, 'buyTargetType', type);
      forbidField(params.getTargetType, 'getTargetType', type);
      break;
    }
    case 'ADVANCED': {
      requireField(params.buyQuantity, 'buyQuantity', type);
      requireField(params.getQuantity, 'getQuantity', type);
      const gdp = requireField(
        params.getDiscountPercent,
        'getDiscountPercent',
        type,
      );
      validateQuantityField(params.buyQuantity!, 'buyQuantity');
      validateQuantityField(params.getQuantity!, 'getQuantity');
      validateGetDiscountPercent(gdp);
      // Forbidden fields
      forbidField(params.appliesTo, 'appliesTo', type);
      forbidField(params.discountType, 'discountType', type);
      forbidField(params.discountValue, 'discountValue', type);
      forbidField(
        params.minPurchaseAmountCents,
        'minPurchaseAmountCents',
        type,
      );
      break;
    }
  }
}
