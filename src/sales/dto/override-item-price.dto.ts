import { IsInt, IsOptional, IsUUID, Min, ValidateIf } from 'class-validator';

export class OverrideItemPriceDto {
  @ValidateIf((o) => o.customPriceCents === undefined)
  @IsUUID()
  @IsOptional()
  priceListId?: string;

  @ValidateIf((o) => o.priceListId === undefined)
  @IsInt()
  @Min(1)
  @IsOptional()
  customPriceCents?: number;
}
