/**
 * Slice C — search query DTO for `GET /sat-keys`.
 *
 * Mirrors `src/sales/dto/search-pos-catalog.dto.ts:19,26`. The global
 * `ValidationPipe` (`main.ts:22-27`) has `transform:true` but NOT
 * `enableImplicitConversion`, so query strings MUST be coerced
 * explicitly via `@Type(() => Number)` before `@IsInt` runs — W2
 * anchor.
 *
 * Limit is hard-capped at 50 (catalog bounded by `ILIMIT 50` per spec —
 * avoids heavy scans on a 52k table).
 */
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchSatKeyDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
