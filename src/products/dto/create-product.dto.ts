import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsEnum,
  Min,
  MaxLength,
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
  @IsBoolean()
  sellInPos?: boolean;

  @IsOptional()
  @IsBoolean()
  includeInOnlineCatalog?: boolean;

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

  // Default price (PUBLICO list) in cents
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceCents?: number;
}
