import { Logger } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  CsvEnum,
  CsvString,
  CsvUuid,
  DateRange,
  MultiValue,
  NumericRange,
} from '../../shared/listing';

export enum ListSalesSortBy {
  confirmedAt = 'confirmedAt',
  totalCents = 'totalCents',
  createdAt = 'createdAt',
}

export enum ListSalesSortOrder {
  asc = 'asc',
  desc = 'desc',
}

export enum ListSalesStatus {
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  CANCELED = 'CANCELED',
}

export enum ListSalesPaymentStatus {
  PAID = 'PAID',
  PARTIAL = 'PARTIAL',
  CREDIT = 'CREDIT',
}

export enum ListSalesDeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export enum ListSalesPaymentMethod {
  CASH = 'CASH',
  CARD_CREDIT = 'CARD_CREDIT',
  CARD_DEBIT = 'CARD_DEBIT',
  TRANSFER = 'TRANSFER',
}

const deprecationLogger = new Logger('ListSalesQueryDto');
const LEGACY_ALIAS_WARN =
  '[DEPRECATION] sales-list query used legacy from/to alias';

const toBoolean = (value: unknown): unknown => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
};

const coerceOptionalDate = (value: unknown): unknown => {
  if (value === undefined || value === null || value === '') return value;
  return value instanceof Date ? value : new Date(value as string);
};

export class ListSalesQueryDto {
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
  limit: number = 20;

  @IsOptional()
  @IsEnum(ListSalesSortBy)
  sortBy: ListSalesSortBy = ListSalesSortBy.confirmedAt;

  @IsOptional()
  @IsEnum(ListSalesSortOrder)
  sortOrder: ListSalesSortOrder = ListSalesSortOrder.desc;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @CsvEnum(ListSalesStatus, { max: 50, field: 'status' })
  status?: MultiValue<ListSalesStatus>;

  @IsOptional()
  @CsvEnum(ListSalesPaymentStatus, { max: 50, field: 'paymentStatus' })
  paymentStatus?: MultiValue<ListSalesPaymentStatus>;

  @IsOptional()
  @CsvEnum(ListSalesDeliveryStatus, { max: 50, field: 'deliveryStatus' })
  deliveryStatus?: MultiValue<ListSalesDeliveryStatus>;

  @IsOptional()
  @CsvEnum(ListSalesPaymentMethod, { max: 50, field: 'paymentMethod' })
  paymentMethod?: MultiValue<ListSalesPaymentMethod>;

  @IsOptional()
  @CsvString({ max: 200, field: 'folio' })
  folio?: MultiValue<string>;

  @IsOptional()
  @CsvUuid({ max: 200, field: 'cashierUserId' })
  cashierUserId?: MultiValue<string>;

  @IsOptional()
  @CsvUuid({ max: 200, field: 'customerId' })
  customerId?: MultiValue<string>;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  customerIncludeNull: boolean = false;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  paymentMethodIncludeNull: boolean = false;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  dueDateIncludeNull: boolean = false;

  @IsOptional()
  @NumericRange({ peer: 'totalMax', role: 'min', field: 'total' })
  totalMin?: number;

  @IsOptional()
  @NumericRange({ peer: 'totalMin', role: 'max', field: 'total' })
  totalMax?: number;

  @IsOptional()
  @NumericRange({ peer: 'debtMax', role: 'min', field: 'debt' })
  debtMin?: number;

  @IsOptional()
  @NumericRange({ peer: 'debtMin', role: 'max', field: 'debt' })
  debtMax?: number;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  @DateRange({ peer: 'confirmedTo', role: 'from', field: 'confirmedAt' })
  confirmedFrom: Date | undefined = undefined;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  @DateRange({ peer: 'confirmedFrom', role: 'to', field: 'confirmedAt' })
  confirmedTo: Date | undefined = undefined;

  @IsOptional()
  @DateRange({ peer: 'dueDateTo', role: 'from', field: 'dueDate' })
  dueDateFrom?: Date;

  @IsOptional()
  @DateRange({ peer: 'dueDateFrom', role: 'to', field: 'dueDate' })
  dueDateTo?: Date;

  /** @deprecated Use confirmedFrom instead. Will be removed in a future release. */
  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  from?: Date;

  /** @deprecated Use confirmedTo instead. Will be removed in a future release. */
  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  to?: Date;

  /**
   * Resolve legacy `from`/`to` aliases into the canonical `confirmedFrom`/`confirmedTo`
   * fields. Emits a single deprecation warning per request if legacy fields were used.
   *
   * Must be called AFTER class-validator validation succeeds (typically from the service
   * layer at the start of `listSales(query)`).
   */
  resolveLegacyAlias(): void {
    const legacyUsed = this.from !== undefined || this.to !== undefined;
    if (legacyUsed) {
      deprecationLogger.warn(LEGACY_ALIAS_WARN);
    }
    if (this.confirmedFrom === undefined && this.from !== undefined) {
      this.confirmedFrom = this.from;
    }
    if (this.confirmedTo === undefined && this.to !== undefined) {
      this.confirmedTo = this.to;
    }
  }
}
