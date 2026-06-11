import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BotSaleItemDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  @IsOptional()
  variantId?: string | null;

  @IsString()
  @IsNotEmpty()
  productName!: string;

  @IsString()
  @IsOptional()
  variantName?: string | null;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  unitPriceCents!: number;
}

export class RegisterBotSaleRequestDto {
  /** ID of the POS user acting as cashier for this bot-created order. */
  @IsUUID()
  cashierUserId!: string;

  @IsUUID()
  customerId!: string;

  @IsUUID()
  @IsOptional()
  shippingAddressId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BotSaleItemDto)
  items!: BotSaleItemDto[];
}
