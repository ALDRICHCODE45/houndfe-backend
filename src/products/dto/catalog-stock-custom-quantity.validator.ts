/**
 * Reusable cross-field validator for the online-catalog stock-presentation
 * pair (`onlineStockPresentation` + `onlineStockPresentationCustomQty`),
 * shared by product create and PATCH DTOs (design.md §6).
 *
 * Invariants: non-null quantities are integers >= 0; explicit
 * `CUSTOM_QUANTITY` requires a non-null quantity (create and PATCH); an
 * explicit non-custom mode — including explicit `null` — rejects a non-null
 * quantity; explicit null mode with null/omitted quantity is valid; an
 * omitted mode defers the relationship only on DTOs marked with
 * `@OnlineStockPatchDefersModeQuantityRule()` (PATCH, service re-validates
 * against merged state). Create stays strict.
 *
 * The quantity property carries no `@IsOptional` on purpose: the constraint
 * owns the null/omitted cases, so a `CUSTOM_QUANTITY` request can never skip
 * quantity validation (a `@ValidateIf` gating every validator on the property
 * is the rejected defect). On PATCH, PartialType's inherited `@IsOptional`
 * does skip null/undefined quantities — the mode-side guard constraint below
 * re-checks that case from the non-skipped mode property.
 */
import 'reflect-metadata';
import { CatalogStockPresentation } from '@prisma/client';
import { TransformFnParams } from 'class-transformer';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

type OnlineStockFields = {
  onlineStockPresentation?: CatalogStockPresentation | null;
  onlineStockPresentationCustomQty?: number | null;
};

/**
 * Class-level marker (not copied by PartialType, which only inherits
 * property metadata): an omitted mode defers the cross-field rule to the
 * service.
 */
export const ONLINE_STOCK_DEFER_MODE_QUANTITY_RULE =
  'onlineStock:deferModeQuantityRule';

export function OnlineStockPatchDefersModeQuantityRule(): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(ONLINE_STOCK_DEFER_MODE_QUANTITY_RULE, true, target);
  };
}

function isIntegerAtLeastZero(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Coerces numeric strings like the catalog-settings DTO contract, never
 * letting empty/whitespace strings or non-strings become a passing `0`.
 */
export function coerceCatalogCustomQuantity({
  value,
}: TransformFnParams): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? value : Number(trimmed);
  }
  return value;
}

/** Full cross-field rule, attached to the custom-quantity property. */
@ValidatorConstraint({ name: 'onlineStockCustomQuantity', async: false })
export class OnlineStockCustomQuantityConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const fields = args.object as OnlineStockFields;
    if (value !== null && value !== undefined && !isIntegerAtLeastZero(value)) {
      return false;
    }
    const mode = fields.onlineStockPresentation;
    if (mode === undefined) {
      return (
        value === null ||
        value === undefined ||
        Reflect.getMetadata(
          ONLINE_STOCK_DEFER_MODE_QUANTITY_RULE,
          args.object.constructor,
        ) === true
      );
    }
    if (mode === CatalogStockPresentation.CUSTOM_QUANTITY) {
      return isIntegerAtLeastZero(value);
    }
    return value === null || value === undefined;
  }

  defaultMessage(args: ValidationArguments): string {
    const mode = (args.object as OnlineStockFields).onlineStockPresentation;
    if (mode === CatalogStockPresentation.CUSTOM_QUANTITY) {
      return 'onlineStockPresentationCustomQty must be an integer >= 0 when onlineStockPresentation is CUSTOM_QUANTITY';
    }
    if (mode === undefined) {
      return 'onlineStockPresentationCustomQty requires an explicit onlineStockPresentation';
    }
    return 'onlineStockPresentationCustomQty must be null or omitted unless onlineStockPresentation is CUSTOM_QUANTITY';
  }
}

/**
 * Mode-side guard: PartialType's inherited `@IsOptional` skips the quantity
 * constraint on omitted/null PATCH quantities, so a `CUSTOM_QUANTITY`
 * request without a quantity is re-checked here on the (always non-null
 * in that case) mode property. Type/bound checks stay in the quantity
 * constraint.
 */
@ValidatorConstraint({ name: 'onlineStockCustomQtyRequired', async: false })
export class OnlineStockCustomQtyRequiredConstraint implements ValidatorConstraintInterface {
  validate(mode: unknown, args: ValidationArguments): boolean {
    if (mode !== CatalogStockPresentation.CUSTOM_QUANTITY) {
      return true;
    }
    const quantity = (args.object as OnlineStockFields)
      .onlineStockPresentationCustomQty;
    return quantity !== null && quantity !== undefined;
  }

  defaultMessage(): string {
    return 'onlineStockPresentationCustomQty is required when onlineStockPresentation is CUSTOM_QUANTITY';
  }
}
