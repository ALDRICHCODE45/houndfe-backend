import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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

/**
 * customers-listing / T1 — query of `GET /customers/listing` (contract §3.2,
 * §3.3, §4.6). Unknown parameters are rejected by the global pipe
 * (`forbidNonWhitelisted`).
 *
 * T3 adds the §4.1–§4.5 filters here. Metric filter params must stay
 * `undefined` when absent (no class-field default), because the §10.1
 * permission check treats any defined metric param as "sent".
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
}
