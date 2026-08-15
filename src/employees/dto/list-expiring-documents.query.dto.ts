import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Sortable fields for `GET /admin/employees-documents/expiring`.
 */
export const EXPIRING_DOCUMENT_SORT_FIELDS = [
  'expiresAt',
  'createdAt',
  'category',
  'employeeName',
] as const;
export type ExpiringDocumentSortField =
  (typeof EXPIRING_DOCUMENT_SORT_FIELDS)[number];

export const EXPIRING_DOCUMENT_SORT_ORDERS = ['asc', 'desc'] as const;
export type ExpiringDocumentSortOrder =
  (typeof EXPIRING_DOCUMENT_SORT_ORDERS)[number];

export class ListExpiringDocumentsQueryDto {
  /** Look-ahead window in days. Documents expiring within this window are returned. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  daysUntilExpiry?: number = 30;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  /**
   * Free-text search, trimmed. Matched case-insensitively against the
   * document's employee (`firstName`, `lastName`, `employeeNumber`) and the
   * document `category` (see `EmployeeDocumentsService.listExpiringTenantWide`).
   * Empty / whitespace-only values are treated as no-filter. A
   * single-character value is rejected by the service with
   * `SEARCH_QUERY_TOO_SHORT`.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  /** Sort field. Defaults to `expiresAt`. */
  @IsOptional()
  @IsEnum(EXPIRING_DOCUMENT_SORT_FIELDS)
  sortBy?: ExpiringDocumentSortField = 'expiresAt';

  /** Sort direction. Defaults to `asc`. */
  @IsOptional()
  @IsEnum(EXPIRING_DOCUMENT_SORT_ORDERS)
  sortOrder?: ExpiringDocumentSortOrder = 'asc';
}
