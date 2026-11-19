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
import {
  ArrayNotEmpty,
  IsBoolean,
  IsIn,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { CsvEnum, type MultiValue } from '../../../shared/listing';
import type {
  CashHandoverKind,
  CashSessionStatus,
} from '../../domain/cash-register.types';
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

/** Exact lifecycle values accepted by the `status` session filter. */
export const CASH_SESSION_STATUS_FILTER = {
  OPEN: 'OPEN',
  COUNTING: 'COUNTING',
  SUBMITTED: 'SUBMITTED',
  CLOSED: 'CLOSED',
} as const satisfies Record<CashSessionStatus, CashSessionStatus>;

export class ListSessionsQueryDto extends CashListQueryDto {
  @IsCashOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictBoolean(value))
  @IsBoolean()
  pendingOnly?: boolean;

  /**
   * cash-redesign-reads S3 — exact status filter (any of). Repeated params
   * (`status=OPEN&status=COUNTING`) and a comma list (`status=OPEN,CLOSED`)
   * are both accepted, following the shared listing `CsvEnum` convention;
   * values are deduplicated and an empty value is rejected.
   */
  @IsCashOptional()
  @CsvEnum(CASH_SESSION_STATUS_FILTER, { max: 4, field: 'status' })
  @ArrayNotEmpty()
  status?: MultiValue<CashSessionStatus>;

  /**
   * cash-redesign-reads S3 — physical drawer state: `true` keeps sessions
   * whose drawer is still held (`drawerReleasedAt` null), `false` keeps
   * released drawers.
   */
  @IsCashOptional()
  @Transform(({ value }: { value: unknown }) => parseStrictBoolean(value))
  @IsBoolean()
  drawerOpen?: boolean;
}

export class ListClosingsQueryDto extends CashListQueryDto {}

/**
 * cash-redesign-reads S2 — handover recipient discovery. `kind` is required
 * because the self-recipient rule depends on it (a WITHDRAWAL can never be
 * addressed to its own sender; a FLOAT can). No paging: the list is the
 * tenant's eligible staff.
 */
export class ListHandoverRecipientsQueryDto {
  @IsIn(['WITHDRAWAL', 'FLOAT'])
  kind!: CashHandoverKind;
}

/**
 * S2 — recipient custody discovery. Deliberately exposes ONLY the shared
 * 1-based `page` / `limit`; there is no recipient, tenant or cashier filter,
 * and any extra query key is rejected by `forbidNonWhitelisted`.
 */
export class ListCustodyQueryDto {
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
}
