import { PartialType } from '@nestjs/mapped-types';
import { CreateProductDto } from './create-product.dto';
import { OnlineStockPatchDefersModeQuantityRule } from './catalog-stock-custom-quantity.validator';

/**
 * PATCH product contract. `PartialType` makes every field optional and
 * inherits create-side validation metadata; the class marker below tells
 * the online-stock cross-field validator that an omitted
 * `onlineStockPresentation` defers the mode/quantity relationship to the
 * merged-state service validation (create stays strict).
 */
@OnlineStockPatchDefersModeQuantityRule()
export class UpdateProductDto extends PartialType(CreateProductDto) {}
