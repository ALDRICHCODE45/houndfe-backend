import 'reflect-metadata';
import { Transform } from 'class-transformer';
import { CatalogPublishMode, CatalogStockPresentation } from '@prisma/client';
import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  MaxLength,
  IsEnum,
  Validate,
  ValidateIf,
} from 'class-validator';
import {
  coerceCatalogCustomQuantity,
  OnlineStockCustomQtyRequiredConstraint,
  OnlineStockCustomQuantityConstraint,
  OnlineStockPatchDefersModeQuantityRule,
} from './catalog-stock-custom-quantity.validator';

export class CreateVariantDto {
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

/**
 * PATCH variant contract (design.md §6.2). Catalog publication and
 * stock-presentation fields are PATCH-only: variant create and inline-create
 * persist `INHERIT` with a null stock override, so `CreateVariantDto` never
 * accepts them.
 *
 * `catalogPublishMode` uses undefined-only optionality on purpose: an
 * explicit `null` must be validated — and rejected — rather than silently
 * skipped by the null-tolerant `@IsOptional` check.
 *
 * The stock-presentation pair reuses the shared cross-field validator from
 * `catalog-stock-custom-quantity.validator.ts`. The class marker tells the
 * validator that an omitted `onlineStockPresentation` defers the
 * mode/quantity relationship to the merged-state service validation, exactly
 * like the product PATCH DTO (design.md §6).
 */
@OnlineStockPatchDefersModeQuantityRule()
export class UpdateVariantDto {
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

  /**
   * Variant publication tri-state (design.md §6.2). Omission keeps the
   * stored mode; an explicit `null` is rejected — `INHERIT` is the only
   * way to express inheritance.
   */
  @ValidateIf(
    (o: { catalogPublishMode?: unknown }) => o.catalogPublishMode !== undefined,
  )
  @IsEnum(CatalogPublishMode)
  catalogPublishMode?: CatalogPublishMode;

  /**
   * Stock-presentation override — explicit `null` is valid (clears the
   * override); omission on PATCH keeps the stored value. Cross-field rules
   * with the custom quantity are shared with the product DTOs.
   */
  @IsOptional()
  @IsEnum(CatalogStockPresentation)
  @Validate(OnlineStockCustomQtyRequiredConstraint)
  onlineStockPresentation?: CatalogStockPresentation | null;

  /**
   * Custom display quantity — integer >= 0, only meaningful with
   * `CUSTOM_QUANTITY`. No `@IsOptional` on purpose: the shared cross-field
   * constraint owns null/omitted handling.
   */
  @Transform(coerceCatalogCustomQuantity)
  @Validate(OnlineStockCustomQuantityConstraint)
  onlineStockPresentationCustomQty?: number | null;
}
