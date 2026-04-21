import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import {
  PromotionTypeEnum,
  PromotionMethodEnum,
  CustomerScopeEnum,
} from './create-promotion.dto';

export enum PromotionStatusEnum {
  ACTIVE = 'ACTIVE',
  SCHEDULED = 'SCHEDULED',
  ENDED = 'ENDED',
}

export enum SortByEnum {
  title = 'title',
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
  startDate = 'startDate',
}

export enum SortOrderEnum {
  asc = 'asc',
  desc = 'desc',
}

export class PromotionQueryDto {
  @IsOptional()
  @IsEnum(PromotionTypeEnum)
  type?: PromotionTypeEnum;

  @IsOptional()
  @IsEnum(PromotionStatusEnum)
  status?: PromotionStatusEnum;

  @IsOptional()
  @IsEnum(PromotionMethodEnum)
  method?: PromotionMethodEnum;

  @IsOptional()
  @IsEnum(CustomerScopeEnum)
  customerScope?: CustomerScopeEnum;

  @IsOptional()
  @IsString()
  search?: string;

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

  @IsOptional()
  @IsEnum(SortByEnum)
  sortBy?: SortByEnum;

  @IsOptional()
  @IsEnum(SortOrderEnum)
  sortOrder?: SortOrderEnum;
}
