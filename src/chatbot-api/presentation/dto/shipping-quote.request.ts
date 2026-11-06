import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** shipping-zones / T3 — `POST /chatbot-api/shipping/quotes` (docs/shipping-quotes.md). */
export class ShippingQuoteItemDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity!: number;
}

/** Either `shippingAddressId` alone or the four loose fields (checked by the service). */
export class ShippingQuoteDestinationDto {
  @IsOptional()
  @IsUUID()
  shippingAddressId?: string;

  @IsOptional()
  @Matches(/^\d{5}$/)
  zipCode?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  state?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  municipality?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  neighborhood?: string;
}

export class ShippingQuoteRequestDto {
  @Matches(/^[0-9]{1,10}$/)
  phoneCountryCode!: string;

  @Matches(/^[0-9]{1,20}$/)
  phone!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ShippingQuoteItemDto)
  items!: ShippingQuoteItemDto[];

  @IsObject()
  @ValidateNested()
  @Type(() => ShippingQuoteDestinationDto)
  destination!: ShippingQuoteDestinationDto;
}
