import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import {
  ListingErrorCode,
  ListingHttpException,
  ListingErrorInput,
} from './listing.exceptions';

type ListingContext = {
  code: ListingErrorCode;
  field?: string;
  details?: ListingErrorInput['details'];
};

const firstConstraintMessage = (error: ValidationError): string => {
  const first = error.constraints ? Object.values(error.constraints)[0] : undefined;
  return first ?? `${error.property} is invalid`;
};

export const createListingValidationExceptionFactory = () => {
  return (errors: ValidationError[]) => {
    for (const error of errors) {
      const ctx = error.contexts?.listingError as ListingContext | undefined;
      if (ctx?.code) {
        return new ListingHttpException({
          code: ctx.code,
          message: firstConstraintMessage(error),
          field: ctx.field ?? error.property,
          details: ctx.details,
        });
      }
    }

    return new BadRequestException(errors);
  };
};
