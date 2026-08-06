import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  CsvEnum,
  CsvUuid,
  DateRange,
  MultiValue,
  NumericRange,
} from '../../shared/listing';

/**
 * Query string for `GET /quotations`.
 *
 * WU2 — Pagination + filter query. Mirrors the shape of the Sale list
 * DTO so the FE can swap between the two with a single filter helper.
 *
 * Filters:
 *   - `page`/`limit`     — pagination (defaults 1/20, capped at 100).
 *   - `status`           — CSV multi-value QuotationStatus filter (OR).
 *                          A single value keeps the legacy exact-match
 *                          behaviour (backward compatible).
 *   - `customerId`       — CSV multi-value UUID filter (OR).
 *   - `search`           — case-insensitive `contains` on the assigned
 *                          customer's `firstName` / `lastName` only.
 *   - `createdFrom`/
 *     `createdTo`        — inclusive date range on `createdAt`.
 *   - `expiresFrom`/
 *     `expiresTo`        — inclusive date range on `expiresAt`. Rows with
 *                          `expiresAt = NULL` never match a range.
 *   - `minTotalCents`/
 *     `maxTotalCents`    — inclusive range on `totalCents` (0 is valid).
 *   - `sortBy`           — `createdAt` | `updatedAt` | `expiresAt` |
 *                          `totalCents`. Defaults to `createdAt`.
 *   - `sortOrder`        — `asc` | `desc`. Defaults to `desc`.
 *
 * Semantics: OR inside each multi-value group, AND between groups;
 * stable with page/limit/sort.
 *
 * The lazy EXPIRED transition is applied in the service layer after the
 * DB read (and when status='SENT' is filtered) — the SQL filter stays
 * on the persisted status.
 */
export enum ListQuotationsSortBy {
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
  expiresAt = 'expiresAt',
  totalCents = 'totalCents',
}

export enum ListQuotationsSortOrder {
  asc = 'asc',
  desc = 'desc',
}

export enum ListQuotationsStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

const coerceOptionalDate = (value: unknown): unknown => {
  if (value === undefined || value === null || value === '') return value;
  return value instanceof Date ? value : new Date(value as string);
};

export class QuotationQueryDto {
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
  @IsEnum(ListQuotationsSortBy)
  sortBy: ListQuotationsSortBy = ListQuotationsSortBy.createdAt;

  @IsOptional()
  @IsEnum(ListQuotationsSortOrder)
  sortOrder: ListQuotationsSortOrder = ListQuotationsSortOrder.desc;

  @IsOptional()
  @CsvEnum(ListQuotationsStatus, { max: 50, field: 'status' })
  status?: MultiValue<ListQuotationsStatus>;

  @IsOptional()
  @CsvUuid({ max: 200, field: 'customerId' })
  customerId?: MultiValue<string>;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  createdFrom?: Date;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  createdTo?: Date;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  @DateRange({ peer: 'expiresTo', role: 'from', field: 'expiresAt' })
  expiresFrom?: Date;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  @DateRange({ peer: 'expiresFrom', role: 'to', field: 'expiresAt' })
  expiresTo?: Date;

  @IsOptional()
  @NumericRange({ peer: 'maxTotalCents', role: 'min', field: 'total' })
  minTotalCents?: number;

  @IsOptional()
  @NumericRange({ peer: 'minTotalCents', role: 'max', field: 'total' })
  maxTotalCents?: number;
}
