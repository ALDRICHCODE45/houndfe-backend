import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TierPriceDto {
  @IsInt()
  @Min(0)
  minQuantity: number;

  @IsNumber()
  @Min(0)
  priceCents: number;
}

export class CreatePriceListDto {
  @IsString()
  @MaxLength(50)
  name: string;

  @IsNumber()
  @Min(0)
  priceCents: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierPriceDto)
  tierPrices?: TierPriceDto[];
}

export class UpdatePriceListDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierPriceDto)
  tierPrices?: TierPriceDto[];
}
