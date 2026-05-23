import { ValidationOptions, isUUID } from 'class-validator';
import { ListingErrorCode } from '../listing.exceptions';
import { applyCsvTransform, registerCsvConstraint } from './csv-decorator.utils';

type CsvUuidOptions = { field: string; max: number };

export function CsvUuid(
  options: CsvUuidOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
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
        name: 'listingInvalidUuid',
        code: ListingErrorCode.LISTING_INVALID_UUID,
        isValid: (values) => values.every((value) => isUUID(value, 4)),
        message: () => `${options.field} is invalid`,
      },
      validationOptions,
    );
  };
}
