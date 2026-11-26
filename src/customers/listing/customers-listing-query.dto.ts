import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  registerDecorator,
} from 'class-validator';
import { FISCAL_REGIMES } from '../domain/constants';
import {
  CsvEnum,
  CsvString,
  CsvUuid,
  DateRange,
  ListingErrorCode,
  NumericRange,
  type MultiValue,
} from '../../shared/listing';

/** Contract §3.3. The metric keys need `read:Sale` (§10.1). */
export enum CustomersListingSortBy {
  name = 'name',
  openDebt = 'openDebt',
  oldestOverdue = 'oldestOverdue',
  lastPurchaseAt = 'lastPurchaseAt',
  totalSold = 'totalSold',
  salesCount = 'salesCount',
  averageTicket = 'averageTicket',
  createdAt = 'createdAt',
}

export enum CustomersListingSortOrder {
  asc = 'asc',
  desc = 'desc',
}

/** Contract §4.3 — `CustomerPetSpecies`, in enum order. */
export enum CustomersListingPetSpecies {
  DOG = 'DOG',
  CAT = 'CAT',
  OTHER = 'OTHER',
}

/** Contract §4.3 — `CustomerPetSize`. */
export enum CustomersListingPetSize {
  SMALL = 'SMALL',
  MEDIUM = 'MEDIUM',
  LARGE = 'LARGE',
  GIANT = 'GIANT',
}

/** Contract §4.4 — `DeliveryZoneType` (there are no named zones). */
export enum CustomersListingDeliveryZoneType {
  FREE = 'FREE',
  SURCHARGE = 'SURCHARGE',
  CARRIER_ONLY = 'CARRIER_ONLY',
  DENIED = 'DENIED',
}

/** Contract §4.5 — the fixed SAT list (`FISCAL_REGIMES`) as a CSV enum. */
const FISCAL_REGIME_ENUM: Record<string, string> = Object.fromEntries(
  FISCAL_REGIMES.map((code) => [code, code]),
);

/** Contract §4: booleans accept only the exact strings `true` / `false`. */
const toBoolean = (value: unknown): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/** §4 `N`-day filters: an integer 1–3650 (standard per-field body, §11). */
function DaysParam(): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Type(() => Number)(target, key);
    IsInt()(target, key);
    Min(1)(target, key);
    Max(3650)(target, key);
  };
}

function BooleanParam(): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Transform(({ value }) => toBoolean(value))(target, key);
    IsBoolean()(target, key);
  };
}

/**
 * A `*Min` / `*Max` bound (money in cents or a count): the shared
 * `@NumericRange` (`LISTING_INVALID_NUMBER` when not a finite number,
 * `LISTING_INVERTED_RANGE`) plus contract §11's addition — a negative or
 * non-integer bound is `LISTING_INVALID_NUMBER` too.
 */
function BoundParam(options: {
  field: string;
  peer: string;
  role: 'min' | 'max';
}): PropertyDecorator {
  return (target, propertyName) => {
    const key = propertyName.toString();
    IsOptional()(target, propertyName);
    NumericRange(options)(target, propertyName);
    registerDecorator({
      name: 'listingNonNegativeInteger',
      target: target.constructor,
      propertyName: key,
      options: {
        context: { code: ListingErrorCode.LISTING_INVALID_NUMBER, field: key },
      },
      validator: {
        validate(value?: number) {
          if (value === undefined || !Number.isFinite(value)) return true;
          return Number.isInteger(value) && value >= 0;
        },
        defaultMessage() {
          return `${key} is invalid`;
        },
      },
    });
  };
}

function DateParam(options: {
  field: string;
  peer: string;
  role: 'from' | 'to';
}): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    DateRange(options)(target, key);
  };
}

/**
 * customers-listing — query of `GET /customers/listing` (contract §3.2,
 * §3.3, §4). Unknown parameters are rejected by the global pipe
 * (`forbidNonWhitelisted`), including `preferredPaymentMethod` (§4.5).
 *
 * Every filter stays `undefined` when absent (no class-field default): the
 * §10.1 permission check treats any defined metric param as "sent", and the
 * service forwards only defined filters.
 */
export class CustomersListingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @IsOptional()
  @IsEnum(CustomersListingSortBy)
  sortBy: CustomersListingSortBy = CustomersListingSortBy.createdAt;

  @IsOptional()
  @IsEnum(CustomersListingSortOrder)
  sortOrder: CustomersListingSortOrder = CustomersListingSortOrder.desc;

  /** Same rule as `GET /customers?search=` (trimmed, 100 chars, 6 words). */
  @IsOptional()
  @IsString()
  search?: string;

  // ───────────── §4.1 Deuda (metric params, §10.1) ─────────────

  @BooleanParam()
  hasDebt?: boolean;

  @BoundParam({ peer: 'openDebtMax', role: 'min', field: 'openDebt' })
  openDebtMin?: number;

  @BoundParam({ peer: 'openDebtMin', role: 'max', field: 'openDebt' })
  openDebtMax?: number;

  @BooleanParam()
  hasOverdue?: boolean;

  /** Strict: overdue by MORE than N days (N = 30 → day 31+). */
  @DaysParam()
  overdueMoreThanDays?: number;

  @DateParam({ peer: 'oldestOverdueTo', role: 'from', field: 'oldestOverdue' })
  oldestOverdueFrom?: Date;

  @DateParam({ peer: 'oldestOverdueFrom', role: 'to', field: 'oldestOverdue' })
  oldestOverdueTo?: Date;

  // ───────────── §4.2 Compras ─────────────

  @BoundParam({ peer: 'totalSoldMax', role: 'min', field: 'totalSold' })
  totalSoldMin?: number;

  @BoundParam({ peer: 'totalSoldMin', role: 'max', field: 'totalSold' })
  totalSoldMax?: number;

  @BoundParam({ peer: 'salesCountMax', role: 'min', field: 'salesCount' })
  salesCountMin?: number;

  @BoundParam({ peer: 'salesCountMin', role: 'max', field: 'salesCount' })
  salesCountMax?: number;

  @BoundParam({ peer: 'averageTicketMax', role: 'min', field: 'averageTicket' })
  averageTicketMin?: number;

  @BoundParam({ peer: 'averageTicketMin', role: 'max', field: 'averageTicket' })
  averageTicketMax?: number;

  @DateParam({ peer: 'lastPurchaseTo', role: 'from', field: 'lastPurchase' })
  lastPurchaseFrom?: Date;

  @DateParam({ peer: 'lastPurchaseFrom', role: 'to', field: 'lastPurchase' })
  lastPurchaseTo?: Date;

  /** Never bought, or the last purchase's local date is before today − N. */
  @DaysParam()
  noPurchaseMoreThanDays?: number;

  /** «Alta» — not a metric param. */
  @DateParam({ peer: 'createdTo', role: 'from', field: 'created' })
  createdFrom?: Date;

  @DateParam({ peer: 'createdFrom', role: 'to', field: 'created' })
  createdTo?: Date;

  // ───────────── §4.3 Mascotas (ACTIVE pets) ─────────────

  @IsOptional()
  @CsvEnum(CustomersListingPetSpecies, { max: 50, field: 'petSpecies' })
  petSpecies?: MultiValue<CustomersListingPetSpecies>;

  @IsOptional()
  @CsvEnum(CustomersListingPetSize, { max: 50, field: 'petSize' })
  petSize?: MultiValue<CustomersListingPetSize>;

  @BoundParam({ peer: 'activePetsMax', role: 'min', field: 'activePets' })
  activePetsMin?: number;

  @BoundParam({ peer: 'activePetsMin', role: 'max', field: 'activePets' })
  activePetsMax?: number;

  @BooleanParam()
  hasPets?: boolean;

  // ───────────── §4.4 Ubicación (any address) ─────────────

  @IsOptional()
  @CsvString({ max: 200, field: 'neighborhood' })
  neighborhood?: MultiValue<string>;

  @IsOptional()
  @CsvString({ max: 200, field: 'municipality' })
  municipality?: MultiValue<string>;

  @IsOptional()
  @CsvString({ max: 200, field: 'city' })
  city?: MultiValue<string>;

  @IsOptional()
  @CsvString({ max: 200, field: 'zipCode' })
  zipCode?: MultiValue<string>;

  @IsOptional()
  @CsvEnum(CustomersListingDeliveryZoneType, {
    max: 50,
    field: 'deliveryZoneType',
  })
  deliveryZoneType?: MultiValue<CustomersListingDeliveryZoneType>;

  /** `true` = «sin zona»; `false` = no filter. */
  @BooleanParam()
  deliveryZoneNone?: boolean;

  // ───────────── §4.5 Comercial y contacto ─────────────

  @IsOptional()
  @CsvUuid({ max: 200, field: 'priceListId' })
  priceListId?: MultiValue<string>;

  @BooleanParam()
  priceListIncludeNull?: boolean;

  @BooleanParam()
  isTrusted?: boolean;

  @BooleanParam()
  hasRfc?: boolean;

  @IsOptional()
  @CsvEnum(FISCAL_REGIME_ENUM, { max: 50, field: 'fiscalRegime' })
  fiscalRegime?: MultiValue<string>;

  @BooleanParam()
  hasEmail?: boolean;

  @BooleanParam()
  hasPhone?: boolean;

  /** At least one `ChatbotRequest` of this customer, any status. */
  @BooleanParam()
  hasChatbotRequests?: boolean;
}
