/**
 * shipping-zones / T1 (S1) — store DTOs for `/delivery-zones`.
 * Validated by the global `createAppValidationPipe()` (whitelist +
 * forbidNonWhitelisted), so unknown keys are a 400.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  DELIVERY_ZONE_TYPES,
  type DeliveryZoneTypeValue,
} from '../../domain/delivery-zone.policy';
import type { DeliveryZoneRecord } from '../../domain/delivery-zone.repository';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ListDeliveryZonesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(DELIVERY_ZONE_TYPES)
  type?: DeliveryZoneTypeValue;

  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';
}

export class UpsertDeliveryZoneDto {
  @IsIn(DELIVERY_ZONE_TYPES)
  type!: DeliveryZoneTypeValue;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  surchargeCents?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  etaDays?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  state?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  municipality?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  neighborhood?: string | null;
}

export interface DeliveryZoneResponse {
  id: string;
  zipCode: string;
  type: DeliveryZoneTypeValue;
  surchargeCents: number | null;
  etaDays: number | null;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
  isActive: boolean;
  approvedBy: { id: string; displayName: string };
  approvedAt: string;
  sourceValidationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDeliveryZoneResponse(
  zone: DeliveryZoneRecord,
): DeliveryZoneResponse {
  return {
    id: zone.id,
    zipCode: zone.zipCode,
    type: zone.type,
    surchargeCents: zone.surchargeCents,
    etaDays: zone.etaDays,
    state: zone.state,
    municipality: zone.municipality,
    neighborhood: zone.neighborhood,
    isActive: zone.isActive,
    approvedBy: {
      id: zone.approvedById,
      displayName: zone.approvedByDisplayName,
    },
    approvedAt: zone.approvedAt.toISOString(),
    sourceValidationId: zone.sourceValidationId,
    createdAt: zone.createdAt.toISOString(),
    updatedAt: zone.updatedAt.toISOString(),
  };
}
