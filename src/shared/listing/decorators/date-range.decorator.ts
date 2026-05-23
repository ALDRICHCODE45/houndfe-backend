import { Transform } from 'class-transformer';
import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { LISTING_VALIDATION_CONTEXT } from './listing-validation-contexts';

type DateRangeOptions = {
  field: string;
  peer: string;
  role: 'from' | 'to';
};

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return value instanceof Date ? value : new Date(value as string);
};

export function DateRange(
  options: DateRangeOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    const key = propertyName.toString();

    Transform(({ value }) => toDate(value))(target, propertyName);

    registerDecorator({
      name: 'listingInvalidDate',
      target: target.constructor,
      propertyName: key,
      options: {
        ...validationOptions,
        context: {
          ...LISTING_VALIDATION_CONTEXT.invalidDate,
          field: key,
        },
      },
      validator: {
        validate(value?: Date) {
          if (value === undefined) return true;
          return !Number.isNaN(value.getTime());
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
        validate(value: Date | undefined, args: ValidationArguments) {
          if (value === undefined || Number.isNaN(value.getTime())) return true;
          const peer = (args.object as Record<string, Date | undefined>)[options.peer];
          if (!peer || Number.isNaN(peer.getTime())) return true;
          return options.role === 'from' ? value <= peer : peer <= value;
        },
        defaultMessage() {
          return `${options.field} range is inverted`;
        },
      },
    });
  };
}
