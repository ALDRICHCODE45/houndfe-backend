import { IsOptional, IsUUID } from 'class-validator';

/**
 * F2.WU6 slice 5c — optional explicit public price-context selection
 * (`GlobalPriceList.id`) for the detail route. Omission means the tenant
 * catalog default.
 */
export class PublicPriceContextQueryDto {
  @IsOptional()
  @IsUUID()
  priceListId?: string;
}
