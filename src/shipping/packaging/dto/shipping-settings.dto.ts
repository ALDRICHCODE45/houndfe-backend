/**
 * shipping-zones / T2 (S5) — standard boxes and shipping origin per sucursal.
 *
 * Same units as packaging: integer grams, centimetres with one decimal,
 * 70 kg / 300 cm maxima. Strings are trimmed; blank values are rejected.
 */
import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MAX_PACKAGE_WEIGHT_G, MAX_SIDE_CM } from './packaging.dto';

const CM = { maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false };
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * branch-location — the pin is validated unless it is absent (both omitted)
 * or cleared (both `null`), so a lone or `null`-mixed coordinate fails
 * `@IsNumber` and the request is a 400.
 */
const validateCoordinates = (dto: {
  latitude?: unknown;
  longitude?: unknown;
}): boolean => {
  const bothOmitted = dto.latitude === undefined && dto.longitude === undefined;
  const bothNull = dto.latitude === null && dto.longitude === null;
  return !bothOmitted && !bothNull;
};

export class CreateShippingBoxDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  innerLengthCm!: number;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  innerWidthCm!: number;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  innerHeightCm!: number;

  /** Own weight of the empty box. */
  @IsInt()
  @Min(1)
  @Max(MAX_PACKAGE_WEIGHT_G)
  weightG!: number;

  /** Max weight of the content (box weight excluded). */
  @IsInt()
  @Min(1)
  @Max(MAX_PACKAGE_WEIGHT_G)
  maxContentWeightG!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateShippingBoxDto extends PartialType(CreateShippingBoxDto) {}

export class PutShippingOriginDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  addressLine1!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  addressLine2?: string | null;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  neighborhood!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  municipality!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  state!: string;

  @Matches(/^\d{5}$/, { message: 'postalCode must be exactly 5 digits' })
  postalCode!: string;

  @Matches(/^\+?\d{10,15}$/, {
    message: 'contactPhone must be 10 to 15 digits, optionally prefixed by +',
  })
  contactPhone!: string;

  /**
   * branch-location — the sucursal map pin, sent as a pair. Omitting both
   * keeps the stored pin (clients that do not know it never erase it); `null`
   * in both clears it; anything else (one alone, out of range) is a 400.
   */
  @ValidateIf(validateCoordinates)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ValidateIf(validateCoordinates)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number | null;
}

export interface ShippingBoxView {
  id: string;
  name: string;
  innerLengthCm: number;
  innerWidthCm: number;
  innerHeightCm: number;
  weightG: number;
  maxContentWeightG: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShippingOriginView {
  addressLine1: string;
  addressLine2: string | null;
  neighborhood: string;
  municipality: string;
  state: string;
  postalCode: string;
  contactPhone: string;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}

export interface ShippingOriginResponse {
  configured: boolean;
  origin: ShippingOriginView | null;
}
