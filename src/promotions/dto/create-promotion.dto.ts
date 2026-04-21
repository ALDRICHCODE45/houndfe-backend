import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================
// Enum definitions (mirror domain types)
// ============================================================
export enum PromotionTypeEnum {
  PRODUCT_DISCOUNT = 'PRODUCT_DISCOUNT',
  ORDER_DISCOUNT = 'ORDER_DISCOUNT',
  BUY_X_GET_Y = 'BUY_X_GET_Y',
  ADVANCED = 'ADVANCED',
}

export enum PromotionMethodEnum {
  AUTOMATIC = 'AUTOMATIC',
  MANUAL = 'MANUAL',
}

export enum DiscountTypeEnum {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
}

export enum PromotionTargetTypeEnum {
  CATEGORIES = 'CATEGORIES',
  BRANDS = 'BRANDS',
  PRODUCTS = 'PRODUCTS',
}

export enum CustomerScopeEnum {
  ALL = 'ALL',
  REGISTERED_ONLY = 'REGISTERED_ONLY',
  SPECIFIC = 'SPECIFIC',
}

export enum DayOfWeekEnum {
  MONDAY = 'MONDAY',
  TUESDAY = 'TUESDAY',
  WEDNESDAY = 'WEDNESDAY',
  THURSDAY = 'THURSDAY',
  FRIDAY = 'FRIDAY',
  SATURDAY = 'SATURDAY',
  SUNDAY = 'SUNDAY',
}

// ============================================================
// Nested DTOs for target items
// ============================================================
export class TargetItemDto {
  @IsEnum(PromotionTargetTypeEnum)
  targetType: PromotionTargetTypeEnum;

  @IsString()
  targetId: string;
}

export class BuyTargetItemDto {
  @IsString()
  targetId: string;
}

export class GetTargetItemDto {
  @IsString()
  targetId: string;
}

// ============================================================
// Main create DTO
// ============================================================
export class CreatePromotionDto {
  // ── Shared required ──

  @IsString()
  @MaxLength(200)
  title: string;

  @IsEnum(PromotionTypeEnum)
  type: PromotionTypeEnum;

  @IsEnum(PromotionMethodEnum)
  method: PromotionMethodEnum;

  // ── Dates (optional) ──

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  // ── Customer scope ──

  @IsOptional()
  @IsEnum(CustomerScopeEnum)
  customerScope?: CustomerScopeEnum;

  // ── PRODUCT_DISCOUNT + ORDER_DISCOUNT ──

  @IsOptional()
  @IsEnum(DiscountTypeEnum)
  discountType?: DiscountTypeEnum;

  @IsOptional()
  @IsInt()
  @Min(0)
  discountValue?: number;

  // ── ORDER_DISCOUNT only ──

  @IsOptional()
  @IsInt()
  @Min(0)
  minPurchaseAmountCents?: number;

  // ── PRODUCT_DISCOUNT + BUY_X_GET_Y ──

  @IsOptional()
  @IsEnum(PromotionTargetTypeEnum)
  appliesTo?: PromotionTargetTypeEnum;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TargetItemDto)
  targetItems?: TargetItemDto[];

  // ── BUY_X_GET_Y + ADVANCED ──

  @IsOptional()
  @IsInt()
  @Min(1)
  buyQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  getQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  getDiscountPercent?: number;

  // ── ADVANCED only ──

  @IsOptional()
  @IsEnum(PromotionTargetTypeEnum)
  buyTargetType?: PromotionTargetTypeEnum;

  @IsOptional()
  @IsEnum(PromotionTargetTypeEnum)
  getTargetType?: PromotionTargetTypeEnum;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BuyTargetItemDto)
  buyTargetItems?: BuyTargetItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GetTargetItemDto)
  getTargetItems?: GetTargetItemDto[];

  // ── Conditions ──

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customerIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  priceListIds?: string[];

  @IsOptional()
  @IsArray()
  @IsEnum(DayOfWeekEnum, { each: true })
  daysOfWeek?: DayOfWeekEnum[];
}
