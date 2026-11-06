/**
 * shipping-zones / T2 (S4) — packed-item weight and dimensions.
 *
 * Grams are integers. Centimetres accept one decimal: small pharmacy items
 * (e.g. 2.5 cm) would gain up to 20% volume if rounded up to whole
 * centimetres, which can push an order into a bigger box, and carriers accept
 * decimal centimetres. Maxima follow common parcel-carrier limits (70 kg,
 * 300 cm per side); the database stores DECIMAL(5,1) and CHECKs positivity.
 */
import { IsInt, IsNumber, Max, Min } from 'class-validator';

export const MAX_PACKAGE_WEIGHT_G = 70_000;
export const MAX_SIDE_CM = 300;

const CM = { maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false };

export class PutPackagingDto {
  @IsInt()
  @Min(1)
  @Max(MAX_PACKAGE_WEIGHT_G)
  weightG!: number;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  lengthCm!: number;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  widthCm!: number;

  @IsNumber(CM)
  @Min(0.1)
  @Max(MAX_SIDE_CM)
  heightCm!: number;
}

export interface PackagingView {
  weightG: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  updatedAt: string;
}

export interface ProductPackagingResponse {
  productId: string;
  packaging: PackagingView | null;
}

export interface VariantPackagingResponse {
  productId: string;
  variantId: string;
  /** The variant's own whole record, or null when it inherits. */
  override: PackagingView | null;
  productPackaging: PackagingView | null;
  /** What carriers and the packing rule use for this variant. */
  effective: PackagingView | null;
  source: 'VARIANT' | 'PRODUCT' | null;
}
