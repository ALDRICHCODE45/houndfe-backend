/**
 * DTO: EligibleSalesQueryDto — delivery-routes / T4 (eligible-sales selector).
 *
 * Query string for `GET /delivery-routes/eligible-sales`.
 *
 *   page           1-based page index (default 1, min 1)
 *   limit          page size (default 20, min 1, max 100)
 *   q              free-text search across customer first/last name,
 *                  folio numeric suffix, and the shipping address
 *                  (street / neighborhood / municipality / city / zipCode)
 *   contextRouteId optional route being edited; when present the caller
 *                  must be able to read that route instance and its stops
 *                  drive the `IN_CURRENT_ROUTE` availability state
 *
 * Validation is shape-only; tenant scoping + authorization live in the
 * service (`EligibleSalesService`).
 */
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class EligibleSalesQueryDto {
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
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsUUID('4')
  contextRouteId?: string;
}
