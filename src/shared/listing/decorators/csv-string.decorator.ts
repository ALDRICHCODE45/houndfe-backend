import { ValidationOptions } from 'class-validator';
import { ListingErrorCode } from '../listing.exceptions';
import { applyCsvTransform, registerCsvConstraint } from './csv-decorator.utils';

type CsvStringOptions = { field: string; max: number };

export function CsvString(
  options: CsvStringOptions,
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
  };
}
