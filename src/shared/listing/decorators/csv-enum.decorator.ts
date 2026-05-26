import { ValidationOptions } from 'class-validator';
import { ListingErrorCode } from '../listing.exceptions';
import {
  applyCsvTransform,
  registerCsvConstraint,
} from './csv-decorator.utils';

type CsvEnumOptions = { field: string; max: number };

export function CsvEnum<T extends Record<string, string>>(
  enumObj: T,
  options: CsvEnumOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const allowed = Object.values(enumObj);

  return (target: object, propertyName: string | symbol) => {
    const key = propertyName.toString();
    applyCsvTransform(options)(target, propertyName);

    registerCsvConstraint(
      target,
      key,
      options,
      {
        name: 'listingTooManyValues',
        code: ListingErrorCode.LISTING_TOO_MANY_VALUES,
        isValid: (values) => values.length <= options.max,
        message: () => `${options.field} exceeds max values`,
        details: { cap: options.max },
      },
      validationOptions,
    );

    registerCsvConstraint(
      target,
      key,
      options,
      {
        name: 'listingInvalidEnumValue',
        code: ListingErrorCode.LISTING_INVALID_ENUM_VALUE,
        isValid: (values) => values.every((value) => allowed.includes(value)),
        message: () => `${options.field} is invalid`,
        details: { allowed },
      },
      validationOptions,
    );
  };
}
