import { Transform } from 'class-transformer';
import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { LISTING_VALIDATION_CONTEXT } from './listing-validation-contexts';

type NumericRangeOptions = {
  field: string;
  peer: string;
  role: 'min' | 'max';
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
};

export function NumericRange(
  options: NumericRangeOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    const key = propertyName.toString();

    Transform(({ value }) => toNumber(value))(target, propertyName);

    registerDecorator({
      name: 'listingInvalidNumber',
      target: target.constructor,
      propertyName: key,
      options: {
        ...validationOptions,
        context: {
          ...LISTING_VALIDATION_CONTEXT.invalidNumber,
          field: key,
        },
      },
      validator: {
        validate(value?: number) {
          if (value === undefined) return true;
          return Number.isFinite(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} is invalid`;
        },
      },
    });

    registerDecorator({
      name: 'listingInvertedRange',
      target: target.constructor,
      propertyName: key,
      options: {
        ...validationOptions,
        context: {
          ...LISTING_VALIDATION_CONTEXT.invertedRange,
          field: options.field,
        },
      },
      validator: {
        validate(value: number | undefined, args: ValidationArguments) {
          if (value === undefined || !Number.isFinite(value)) return true;
          const peer = (args.object as Record<string, number | undefined>)[
            options.peer
          ];
          if (peer === undefined || !Number.isFinite(peer)) return true;
          return options.role === 'min' ? value <= peer : peer <= value;
        },
        defaultMessage() {
          return `${options.field} range is inverted`;
        },
      },
    });
  };
}
