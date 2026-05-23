import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { createListingValidationExceptionFactory } from './listing-validation-exception.factory';

describe('createListingValidationExceptionFactory', () => {
  it('maps listing context errors to ListingHttpException envelope', () => {
    const factory = createListingValidationExceptionFactory();
    const error = new ValidationError();
    error.property = 'paymentStatus';
    error.contexts = {
      listingError: {
        code: 'LISTING_INVALID_ENUM_VALUE',
        field: 'paymentStatus',
        details: { allowed: ['PAID', 'PARTIAL', 'CREDIT'] },
      },
    };

    const exception = factory([error]);

    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: 'LISTING_INVALID_ENUM_VALUE',
      message: 'paymentStatus is invalid',
      field: 'paymentStatus',
      details: { allowed: ['PAID', 'PARTIAL', 'CREDIT'] },
    });
  });

  it('falls back to BadRequestException when no listing context is present', () => {
    const factory = createListingValidationExceptionFactory();
    const error = new ValidationError();
    error.property = 'limit';
    error.constraints = { max: 'limit must not be greater than 100' };

    const exception = factory([error]);

    expect(exception).toBeInstanceOf(BadRequestException);
    expect(exception.getStatus()).toBe(400);
  });
});
