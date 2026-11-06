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
} from 'class-validator';
import { MAX_PACKAGE_WEIGHT_G, MAX_SIDE_CM } from './packaging.dto';

const CM = { maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false };
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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
  updatedAt: string;
}

export interface ShippingOriginResponse {
  configured: boolean;
  origin: ShippingOriginView | null;
}
