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

export class ValidateCartBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  @ArrayMinSize(1)
  items: CartItemDto[];

  /**
   * F2.WU7 slice 4 — optional explicit `GlobalPriceList.id`; omission means
   * the tenant catalog default. Legacy `customer`/client pricing fields are
   * rejected by the global whitelist + forbidNonWhitelisted pipe.
   */
  @IsOptional()
  @IsUUID()
  priceListId?: string;
}
