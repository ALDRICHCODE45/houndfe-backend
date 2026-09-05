import {
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

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
