import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Query string for `GET /quotations`.
 *
 * WU2 — Pagination + filter query. Mirrors the shape of the Sale list
 * DTO so the FE can swap between the two with a single filter helper.
 *
 * Filters:
 *   - `page`/`limit`     — pagination (defaults 1/20, capped at 100).
 *   - `status`           — single QuotationStatus filter (exact match).
 *                          Multi-value + customer-name search are out of
 *                          WU2 scope (spec only requires status,
 *                          customerId, date range).
 *   - `customerId`       — UUID filter, exact match.
 *   - `createdFrom`/
 *     `createdTo`        — inclusive date range on `createdAt`.
 *   - `sortBy`           — `createdAt` | `updatedAt` | `expiresAt` |
 *                          `totalCents`. Defaults to `createdAt`.
 *   - `sortOrder`        — `asc` | `desc`. Defaults to `desc`.
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
  @IsEnum(['DRAFT', 'SENT', 'EXPIRED', 'CANCELLED'])
  status?: 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED';

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  createdFrom?: Date;

  @IsOptional()
  @Transform(({ value }) => coerceOptionalDate(value))
  createdTo?: Date;
}
