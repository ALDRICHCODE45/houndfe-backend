import { HttpException } from '@nestjs/common';
import {
  DomainError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import {
  BACKORDER_ERROR_STATUS,
  BackorderError,
  type BackorderErrorDetails,
} from '../domain/backorder-error';

const CODE_SHAPE = /^[A-Z][A-Z_]{1,79}$/;

/** Code-only body (`error === message`), like `checkoutError`, plus the contract's detail member. */
export function backorderHttpError(
  statusCode: number,
  code: string,
  details: BackorderErrorDetails = {},
): HttpException {
  return new HttpException(
    { statusCode, error: code, message: code, ...details },
    statusCode,
  );
}

/**
 * New boundary only: never return or persist raw driver/domain messages.
 * Backorder errors keep their contract status and detail; a code-shaped
 * `DomainError` from a shared service (pricing, idempotency-key pipe) keeps its
 * code with the status the checkout boundary gives it; everything else is a
 * generic 500.
 */
export function toBackorderHttpError(error: unknown): HttpException {
  if (error instanceof BackorderError) {
    return backorderHttpError(error.status, error.code, error.details);
  }
  if (error instanceof DomainError && CODE_SHAPE.test(error.code)) {
    const known = (BACKORDER_ERROR_STATUS as Record<string, number>)[
      error.code
    ];
    const status = known ?? (error instanceof InvalidArgumentError ? 400 : 422);
    return backorderHttpError(status, error.code);
  }
  if (error instanceof HttpException) return error;
  return backorderHttpError(500, 'BACKORDER_REQUEST_FAILED');
}
