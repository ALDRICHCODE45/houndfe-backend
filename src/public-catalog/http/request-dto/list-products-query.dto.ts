import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  IsInt,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** `<definition code>:<option code>`, e.g. `animal.target:ani.dom.dog`. */
const FACET_TOKEN = /^[A-Za-z0-9._-]{1,120}:[A-Za-z0-9._-]{1,120}$/;

export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  /**
   * F2.WU6 slice 5b — optional explicit public price-context selection
   * (`GlobalPriceList.id`). Omission means the tenant catalog default.
   */
  @IsOptional()
  @IsUUID()
  priceListId?: string;

  /**
   * P4 S4 — repeatable FACET selection `facet=<definition>:<option>`: OR
   * within a definition, AND between definitions. Only with the tenant's
   * Published-editorial switch on; vocabulary membership is checked later
   * (unknown → 400 FACET_NOT_AVAILABLE).
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? [value] : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(FACET_TOKEN, { each: true })
  facet?: string[];

  @IsOptional()
  @IsIn(['relevance', 'price_asc', 'price_desc', 'newest', 'rating_desc'])
  sort?: string = 'newest';

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
}
