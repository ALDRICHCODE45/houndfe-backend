/**
 * ListProductsQueryDto — Query contract for `GET /products`.
 *
 * Mirrors the convention established by `promotion-query.dto.ts` (canonical
 * `search` term) and `list-sales-query.dto.ts` (`page` / `limit` pagination
 * with `Max(100)` cap). `search` is matched against `Product.name`,
 * `Product.sku`, and `Product.barcode` (case-insensitive, trimmed) by the
 * service layer — see `ProductsService.findAll`.
 *
 * NOTE: We deliberately do NOT alias `q` to `search`. The codebase's
 * canonical search term is `search` (see promotions DTO). Frontend callers
 * should send `?search=...`.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListProductsQueryDto {
  /**
   * Optional search term. Matched case-insensitively against the product's
   * `name`, `sku`, and `barcode` columns. Whitespace is trimmed by the
   * service; empty / whitespace-only values are treated as no-filter.
   */
  @IsOptional()
  @IsString()
  search?: string;

  /** 1-based page number. Omit to skip pagination entirely. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Max rows to return. Capped at 100 to bound DB work per request. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
