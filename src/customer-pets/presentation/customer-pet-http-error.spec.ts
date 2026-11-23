import { BadRequestException, HttpException } from '@nestjs/common';
import {
  CUSTOMER_PET_ERROR_STATUS,
  CustomerPetError,
  CustomerPetValidationError,
  type CustomerPetErrorCode,
} from '../domain/customer-pet-error';
import { toPetHttpError } from './customer-pet-http-error';

describe('customer pet error statuses (contract §8)', () => {
  const expected: Record<string, number> = {
    PET_NOT_FOUND: 404,
    CUSTOMER_NOT_FOUND: 404,
    PET_VERSION_CONFLICT: 409,
    PET_ARCHIVED: 422,
    PET_NOT_ARCHIVED: 422,
    PET_LIMIT_REACHED: 422,
    PET_CUSTOMER_MISMATCH: 422,
  };

  it.each(Object.entries(expected))('%s answers %i', (code, status) => {
    expect(CUSTOMER_PET_ERROR_STATUS[code as CustomerPetErrorCode]).toBe(
      status,
    );
    const http = toPetHttpError(
      new CustomerPetError(code as CustomerPetErrorCode),
    );
    expect(http.getStatus()).toBe(status);
    expect(http.getResponse()).toEqual({
      statusCode: status,
      error: code,
      message: code,
    });
  });
});

describe('toPetHttpError', () => {
  it('puts currentVersion at the body root of PET_VERSION_CONFLICT', () => {
    const http = toPetHttpError(
      new CustomerPetError('PET_VERSION_CONFLICT', { currentVersion: 4 }),
    );
    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toEqual({
      statusCode: 409,
      error: 'PET_VERSION_CONFLICT',
      message: 'PET_VERSION_CONFLICT',
      currentVersion: 4,
    });
  });

  it('maps a validation error to the 400 per-field array the customer DTOs produce', () => {
    const http = toPetHttpError(
      new CustomerPetValidationError([
        {
          field: 'birthDate',
          rule: 'birthDateInFuture',
          message: 'birthDate must not be in the future',
        },
      ]),
    );
    expect(http).toBeInstanceOf(BadRequestException);
    expect(http.getStatus()).toBe(400);
    expect(http.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: [
        {
          property: 'birthDate',
          children: [],
          constraints: {
            birthDateInFuture: 'birthDate must not be in the future',
          },
        },
      ],
    });
  });

  it('passes an HttpException through untouched', () => {
    const original = new HttpException('x', 418);
    expect(toPetHttpError(original)).toBe(original);
  });

  it('hides anything unknown behind a generic 500 with no raw message', () => {
    const http = toPetHttpError(new Error('connection to 10.0.0.1 refused'));
    expect(http.getStatus()).toBe(500);
    expect(http.getResponse()).toEqual({
      statusCode: 500,
      error: 'CUSTOMER_PET_REQUEST_FAILED',
      message: 'CUSTOMER_PET_REQUEST_FAILED',
    });
  });
});
