import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class EvaluateCartItemRequestDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitPriceCents!: number;
}

export class EvaluateCartRequestDto {
  @ValidateIf(hasCustomerPhone)
  @Matches(/^[0-9]{1,10}$/)
  phoneCountryCode?: string;

  @ValidateIf(hasCustomerPhone)
  @Matches(/^[0-9]{1,20}$/)
  phone?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EvaluateCartItemRequestDto)
  items!: EvaluateCartItemRequestDto[];
}

function hasCustomerPhone(input: EvaluateCartRequestDto): boolean {
  return input.phoneCountryCode !== undefined || input.phone !== undefined;
}
