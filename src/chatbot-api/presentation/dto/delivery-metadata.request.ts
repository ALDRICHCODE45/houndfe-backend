import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DeliveryMetadataRequestDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  carrierName?: string | null;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  trackingRef?: string | null;

  @IsISO8601()
  @IsOptional()
  estimatedDeliveryAt?: string | null;
}
