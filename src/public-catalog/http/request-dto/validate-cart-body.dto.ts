import {
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CartItemDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CartCustomerDto {
  @IsOptional()
  @IsUUID()
  globalPriceListId?: string;
}

export class ValidateCartBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  @ArrayMinSize(1)
  items: CartItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CartCustomerDto)
  customer?: CartCustomerDto;
}
