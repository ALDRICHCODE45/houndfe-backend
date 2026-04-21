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
 * Derive initial status from dates (used in create).
 * Manual ENDED override is applied AFTER this in end().
 */
function deriveStatus(
  startDate: Date | null,
  endDate: Date | null,
): PromotionStatus {
  const now = new Date();
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
    return new Promotion({
      id: params.id,
      title,
      type: params.type,
      method: params.method,
      status: deriveStatus(startDate, endDate),
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
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    });
  }

  // ============================================================
  // getEffectiveStatus — lazy evaluation
  // ============================================================
  getEffectiveStatus(now: Date): PromotionStatus {
    // Manual ENDED override is permanent
    if (this.status === 'ENDED') return 'ENDED';

    if (this.startDate && this.startDate > now) return 'SCHEDULED';
    if (this.endDate && this.endDate < now) return 'ENDED';
    return 'ACTIVE';
  }

  // ============================================================
  // end() — irreversibly end the promotion
  // ============================================================
  end(): void {
    if (this.status === 'ENDED') return; // idempotent
    this.status = 'ENDED';
    if (!this.endDate) {
      this.endDate = new Date();
    }
    this.updatedAt = new Date();
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
