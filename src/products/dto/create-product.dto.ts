import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsArray,
  IsInt,
  IsUrl,
  IsDateString,
  Min,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PurchaseCostDto {
  @IsEnum(['NET', 'GROSS'])
  mode: 'NET' | 'GROSS';

  @IsNumber()
  @Min(0)
  valueCents: number;
}

// ── Inline sub-resource DTOs for atomic product creation ──

export class CreateVariantInlineDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  option?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  value?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseNetCostCents?: number | null;
}

export class CreateLotInlineDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  lotNumber: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsDateString()
  manufactureDate?: string;

  @IsDateString()
  expirationDate: string;
}

export class InlineTierPriceDto {
  @IsInt()
  @Min(0)
  minQuantity: number;

  @IsNumber()
  @Min(0)
  priceCents: number;
}

export class CreatePriceListInlineDto {
  @IsString()
  priceListId: string;

  @IsNumber()
  @Min(0)
  priceCents: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InlineTierPriceDto)
  tierPrices?: InlineTierPriceDto[];
}

export class CreateImageInlineDto {
  @IsString()
  @IsUrl()
  url: string;

  @IsOptional()
  @IsBoolean()
  isMain?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sortOrder?: number;
}

export class CreateProductDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(['PRODUCT', 'SERVICE'])
  type?: 'PRODUCT' | 'SERVICE';

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsEnum([
    'UNIDAD',
    'CAJA',
    'BOLSA',
    'METRO',
    'CENTIMETRO',
    'KILOGRAMO',
    'GRAMO',
    'LITRO',
  ])
  unit?: string;

  @IsOptional()
  @IsString()
  satKey?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsBoolean()
  sellInPos?: boolean;

  @IsOptional()
  @IsBoolean()
  includeInOnlineCatalog?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresPrescription?: boolean;

  @IsOptional()
  @IsBoolean()
  chargeProductTaxes?: boolean;

  @IsOptional()
  @IsEnum(['IVA_16', 'IVA_8', 'IVA_0', 'IVA_EXENTO'])
  ivaRate?: string;

  @IsOptional()
  @IsEnum([
    'NO_APLICA',
    'IEPS_160',
    'IEPS_53',
    'IEPS_50',
    'IEPS_30_4',
    'IEPS_30',
    'IEPS_26_5',
    'IEPS_25',
    'IEPS_9',
    'IEPS_8',
    'IEPS_7',
    'IEPS_6',
    'IEPS_3',
    'IEPS_0',
  ])
  iepsRate?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PurchaseCostDto)
  purchaseCost?: PurchaseCostDto;

  @IsOptional()
  @IsBoolean()
  useStock?: boolean;

  @IsOptional()
  @IsBoolean()
  useLotsAndExpirations?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  @IsOptional()
  @IsBoolean()
  hasVariants?: boolean;

  // Selling price — redirected to PUBLICO (default) price list. Not a product column.
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceCents?: number;

  // ── Inline sub-resources (optional, atomic creation) ──

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantInlineDto)
  variants?: CreateVariantInlineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateLotInlineDto)
  lots?: CreateLotInlineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePriceListInlineDto)
  priceLists?: CreatePriceListInlineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateImageInlineDto)
  images?: CreateImageInlineDto[];
}
