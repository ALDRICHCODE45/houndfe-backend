import { BadRequestException, HttpException } from '@nestjs/common';
import {
  CustomerPetError,
  CustomerPetValidationError,
} from '../domain/customer-pet-error';

/** Code-only body (`error === message`) plus the contract's detail member. */
export function petHttpError(
  statusCode: number,
  code: string,
  details: Record<string, unknown> = {},
): HttpException {
  return new HttpException(
    { statusCode, error: code, message: code, ...details },
    statusCode,
  );
}

/**
 * Boundary of every pet route (POS now, bot in T2): pet errors keep their
 * contract status and detail; a field validation becomes the same `400` body
 * the global `ValidationPipe` builds for the customer DTOs (`message` = array
 * of `{ property, children, constraints }`); an `HttpException` (pipes, guards)
 * passes through; anything else is a generic 500 with no raw message.
 */
export function toPetHttpError(error: unknown): HttpException {
  if (error instanceof CustomerPetError) {
    return petHttpError(error.status, error.code, error.details);
  }
  if (error instanceof CustomerPetValidationError) {
    return new BadRequestException(
      error.fields.map((f) => ({
        property: f.field,
        children: [],
        constraints: { [f.rule]: f.message },
      })),
    );
  }
  if (error instanceof HttpException) return error;
  return petHttpError(500, 'CUSTOMER_PET_REQUEST_FAILED');
}
