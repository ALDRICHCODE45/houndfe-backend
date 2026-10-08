/**
 * DTOs: cash-register list/history query strings (T3/S1,S3,S7).
 *
 * Pagination is the project-standard 1-based `page` / `limit` with a default
 * `1` / `25` and a hard cap of `100`. Optional `registerId` / `cashierUserId`
 * are UUIDs, and optional `from` / `to` must be ISO-8601 timestamps with an
 * explicit timezone (a local wall-clock string is ambiguous and rejected).
 *
 * Deliberately absent: `tenantId`, the caller identity and any scope flag —
 * the JWT + CASL ability own those, and `forbidNonWhitelisted` rejects them if
 * a client tries to supply them.
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsUUID, Max, Min } from 'class-validator';
import {
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_DEFAULT_PAGE,
  CASH_LIST_MAX_LIMIT,
  CASH_LIST_MAX_PAGE,
  IsCashOptional,
  IsTimeZonedIsoTimestamp,
  parseStrictBoolean,
  parseStrictNonNegativeInteger,
  TrimString,
} from './cash-dto.shared';

/** Shared list filter/bounds inherited by the session and closing queries. */
export class CashListQueryDto {
  @IsCashOptional()
  @Transform(({ value }: { value: unknown }) =>
    parseStrictNonNegativeInteger(value),
  )
  @IsInt()
  @Min(1)
  @Max(CASH_LIST_MAX_PAGE)
  page: number = CASH_LIST_DEFAULT_PAGE;

  @IsCashOptional()
  @Transform(({ value }: { value: unknown }) =>
    parseStrictNonNegativeInteger(value),
  )
  @IsInt()
  @Min(1)
  @Max(CASH_LIST_MAX_LIMIT)
  limit: number = CASH_LIST_DEFAULT_LIMIT;

  @IsCashOptional()
  @IsUUID()
  registerId?: string;

  @IsCashOptional()
  @IsUUID()
  cashierUserId?: string;

  @IsCashOptional()
  @TrimString()
  @IsTimeZonedIsoTimestamp()
  from?: string;

  @IsCashOptional()
  @TrimString()
  @IsTimeZonedIsoTimestamp()
  to?: string;
}

export class ListSessionsQueryDto extends CashListQueryDto {
  @IsCashOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictBoolean(value))
  @IsBoolean()
  pendingOnly?: boolean;
}

export class ListClosingsQueryDto extends CashListQueryDto {}
