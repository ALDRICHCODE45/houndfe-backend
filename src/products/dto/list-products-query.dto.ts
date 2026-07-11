/**
 * ListProductsQueryDto — Query contract for `GET /products`.
 *
 * Mirrors the convention established by `promotion-query.dto.ts` (canonical
 * `search` term) and `list-sales-query.dto.ts` (`page` / `limit` pagination
 * with `Max(100)` cap). `search` is matched against `Product.name`,
 * `Product.sku`, and `Product.barcode` (case-insensitive, trimmed) by the
 * service layer — see `ProductsService.findAll`.
 *
 * Backward-compatibility note — `q` alias:
 * The frontend POS screen sends `?q=` alongside `?search=` (legacy alias).
 * Because the global `ValidationPipe` runs with
 * `whitelist: true, forbidNonWhitelisted: true` (see `src/main.ts`),
 * declaring an unknown query param would 400 the request and leave the
 * product list empty. `q` is therefore declared here as an OPTIONAL
 * legacy alias. The service resolves the effective search term as
 * `search ?? q` (search wins when both are present). The frontend team
 * should be migrated to the canonical `search` term; until then, both
 * are accepted.
 *
 * No other legacy / unknown query params are tolerated on this endpoint.
 * The global pipe remains strict for everything else; relaxing it would
 * weaken validation on mutation endpoints.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListProductsQueryDto {
  /**
   * Canonical search term. Matched case-insensitively against the product's
   * `name`, `sku`, and `barcode` columns. Whitespace is trimmed by the
   * service; empty / whitespace-only values are treated as no-filter.
   */
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Legacy alias of `search`. Accepted for backward compatibility with the
   * frontend POS screen, which sends `?q=` in addition to `?search=`. The
   * service resolves the effective search term as `search ?? q`. New
   * clients should send `?search=...` only.
   */
  @IsOptional()
  @IsString()
  q?: string;

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
