import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { parseCsvMultiValue } from '../parsers/csv-multi-value.parser';
import { ListingErrorCode } from '../listing.exceptions';

type CsvDecoratorOptions = {
  field: string;
  max: number;
};

type CsvConstraint = {
  name: string;
  code: ListingErrorCode;
  isValid: (values: string[]) => boolean;
  message: (args: ValidationArguments) => string;
  details?: Record<string, unknown>;
};

export const applyCsvTransform = (options: CsvDecoratorOptions) =>
  Transform(({ value }) =>
    parseCsvMultiValue(value, {
      field: options.field,
      cap: Number.MAX_SAFE_INTEGER,
    }),
  );

export const registerCsvConstraint = (
  target: object,
  propertyName: string,
  options: CsvDecoratorOptions,
  constraint: CsvConstraint,
  validationOptions?: ValidationOptions,
) => {
  registerDecorator({
    name: constraint.name,
    target: target.constructor,
    propertyName,
    options: {
      ...validationOptions,
      context: {
        code: constraint.code,
        field: options.field,
        details: constraint.details,
      },
    },
    validator: {
      validate(value?: string[]) {
        if (value === undefined) {
          return true;
        }
        return constraint.isValid(value);
      },
      defaultMessage(args: ValidationArguments) {
        return constraint.message(args);
      },
    },
  });
};
