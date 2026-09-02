/**
 * PATCH catalog-settings write contract (design.md §5.4).
 *
 * Pure DTO validation: every field is optional — omission is the only
 * absence, explicit `null` is rejected, except the intentionally
 * nullable `catalogDefaultPriceListId` — and strict at the HTTP
 * boundary. Repository/domain-dependent rules — list
 * existence, default being public, publish-requires-default — belong to
 * the update use case and the settings aggregate. The global
 * ValidationPipe uses `whitelist` + `forbidNonWhitelisted` +
 * `transform`, so unknown properties/enum values fail with 400.
 */
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { CatalogStockPresentation } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Cross-field rule (design.md §927): `CUSTOM_QUANTITY` requires an
 * integer quantity >= 0; every other mode requires `customQuantity` to
 * be null or omitted. Re-checked by the settings aggregate as defense
 * in depth.
 */
@ValidatorConstraint({ name: 'stockPresentationCustomQuantity', async: false })
export class StockPresentationCustomQuantityConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const mode = (args.object as StockPresentationSettingDto).mode;
    if (mode === CatalogStockPresentation.CUSTOM_QUANTITY) {
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    }
    return value === null || value === undefined;
  }

  defaultMessage(args: ValidationArguments): string {
    const mode = (args.object as StockPresentationSettingDto).mode;
    return mode === CatalogStockPresentation.CUSTOM_QUANTITY
      ? 'customQuantity must be an integer >= 0 when mode is CUSTOM_QUANTITY'
      : 'customQuantity must be null or omitted unless mode is CUSTOM_QUANTITY';
  }
}

/**
 * Coerces numeric strings like the global transform pipe, while
 * preserving `null`/`undefined` and refusing empty/whitespace strings
 * and non-string non-numbers: `Number('')`, `Number(null)`, and
 * `Number(true)` would otherwise coerce to a passing `0`/`1`.
 */
function transformCustomQuantity({ value }: TransformFnParams): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? value : Number(trimmed);
  }
  return value;
}

export class StockPresentationSettingDto {
  @IsEnum(CatalogStockPresentation)
  mode: CatalogStockPresentation;

  /**
   * The custom constraint is the sole validator on purpose:
   * `@IsOptional` would silently accept `CUSTOM_QUANTITY` without a
   * quantity, and `@ValidateIf` gates every validator on the property
   * (including `@Validate`), so `IsInt`/`Min` cannot be combined with
   * the cross-field rule. The constraint owns the null/type/integer/
   * bound/cross-field decision; `transformCustomQuantity` coerces
   * numeric strings like the global transform pipe, preserves explicit
   * `null`, and never lets empty/whitespace strings coerce to zero.
   */
  @Transform(transformCustomQuantity)
  @Validate(StockPresentationCustomQuantityConstraint)
  customQuantity?: number | null;
}

/**
 * PATCH optionality: unlike `@IsOptional`, validation is skipped only
 * when the property is omitted (`undefined`), so an explicit `null`
 * is still type-checked and rejected on non-nullable PATCH fields.
 */
function IsPatchOptional(): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined);
}

export class UpdateCatalogSettingsDto {
  @IsPatchOptional()
  @IsBoolean()
  catalogPublished?: boolean;

  @IsPatchOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  publicPriceListIds?: string[];

  /**
   * Explicit `null` clears the default binding (this field keeps
   * `@IsOptional` on purpose — it is the only nullable PATCH field).
   * Membership in `publicPriceListIds` and the
   * publish-requires-default rule are use-case/domain concerns, not
   * DTO concerns.
   */
  @IsOptional()
  @IsUUID('4')
  catalogDefaultPriceListId?: string | null;

  @IsPatchOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StockPresentationSettingDto)
  stockPresentationDefault?: StockPresentationSettingDto;
}
