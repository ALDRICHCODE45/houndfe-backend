import { ValidationPipe } from '@nestjs/common';
import { createListingValidationExceptionFactory } from './listing-validation-exception.factory';

export function createAppValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: createListingValidationExceptionFactory(),
  });
}
