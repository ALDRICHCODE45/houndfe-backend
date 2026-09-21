import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * pending-refund-obligations / prf-3 — query DTO for the
 * application listing use case.
 *
 * Deliberately reuses the 1-based `page` / `limit` contract already
 * published by `ListSalesQueryDto`: same defaults (1 / 20), same hard cap
 * (100), and the same string→number coercion, so every sales listing
 * shares one URI pagination language. Bounds are enforced here (not only
 * in the adapter) so a hostile `limit` can never reach the database.
 */
export class ListPendingRefundsQueryDto {
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
}
