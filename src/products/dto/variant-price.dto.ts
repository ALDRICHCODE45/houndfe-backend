import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VariantTierPriceDto {
  @IsInt()
  @Min(0)
  minQuantity: number;

  @IsNumber()
  @Min(0)
  priceCents: number;
}

export class UpsertVariantPriceDto {
  @IsNumber()
  @Min(0)
  priceCents: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantTierPriceDto)
  tierPrices?: VariantTierPriceDto[];
}

export class BulkVariantPriceItemDto extends UpsertVariantPriceDto {
  @IsUUID()
  @IsString()
  priceListId: string;
}

export class BulkUpsertVariantPricesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkVariantPriceItemDto)
  prices: BulkVariantPriceItemDto[];
}
