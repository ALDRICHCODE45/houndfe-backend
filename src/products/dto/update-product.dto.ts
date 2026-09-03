import { OmitType, PartialType } from '@nestjs/mapped-types';
import { ArrayUnique, IsArray, IsUUID, ValidateIf } from 'class-validator';
import {
  catalogPriceListIdUniquenessKey,
  CreateProductDto,
} from './create-product.dto';
import { OnlineStockPatchDefersModeQuantityRule } from './catalog-stock-custom-quantity.validator';

/**
 * PATCH product contract. `OmitType` drops `supportedCatalogPriceListIds`
 * from the inherited partial and `PartialType` makes every other field
 * optional with exactly the WU4b1 validation metadata; the class marker
 * below tells the online-stock cross-field validator that an omitted
 * `onlineStockPresentation` defers the mode/quantity relationship to the
 * merged-state service validation (create stays strict).
 *
 * `supportedCatalogPriceListIds` is redeclared with undefined-only
 * optionality on purpose: the inherited `@IsOptional` would silently skip
 * validation for an explicit `null`. The `ValidateIf` redeclaration keeps
 * an omitted field accepted while every defined value — including `null`
 * — is validated and rejected unless it is a UUID v4 array that is
 * unique case-insensitively, exactly matching create.
 */
@OnlineStockPatchDefersModeQuantityRule()
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['supportedCatalogPriceListIds'] as const),
) {
  @ValidateIf(
    (o: { supportedCatalogPriceListIds?: unknown }) =>
      o.supportedCatalogPriceListIds !== undefined,
  )
  @IsArray()
  @ArrayUnique(catalogPriceListIdUniquenessKey)
  @IsUUID('4', { each: true })
  supportedCatalogPriceListIds?: string[];
}
