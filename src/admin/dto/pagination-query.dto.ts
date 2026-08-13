import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Sortable user fields for `GET /admin/users`.
 */
export const USER_SORT_FIELDS = ['name', 'email', 'createdAt'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const USER_SORT_ORDERS = ['asc', 'desc'] as const;
export type UserSortOrder = (typeof USER_SORT_ORDERS)[number];

export class PaginationQueryDto {
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
   * user's `name`, `email` and `role.name` (see `AdminUserService.findAll`).
   * Empty / whitespace-only values are treated as no-filter. A
   * single-character value is rejected by the service with
   * `SEARCH_QUERY_TOO_SHORT`.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  /** Sort field. Defaults to `name`. */
  @IsOptional()
  @IsEnum(USER_SORT_FIELDS)
  sortBy?: UserSortField = 'name';

  /** Sort direction. Defaults to `asc`. */
  @IsOptional()
  @IsEnum(USER_SORT_ORDERS)
  sortOrder?: UserSortOrder = 'asc';
}
