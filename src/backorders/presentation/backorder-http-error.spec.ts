import { HttpException } from '@nestjs/common';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import {
  BACKORDER_ERROR_STATUS,
  BackorderError,
  type BackorderErrorCode,
} from '../domain/backorder-error';
import { toBackorderHttpError } from './backorder-http-error';

describe('backorder error statuses (§6.1, §6.4)', () => {
  const expected: Record<string, number> = {
    STOCK_AVAILABLE_NOW: 409,
    BACKORDER_DUPLICATE: 409,
    PRICE_OUT_OF_DATE: 409,
    SOURCE_DECISION_NOT_ESTIMATED: 409,
    PRODUCT_NOT_FOUND: 404,
    VARIANT_NOT_FOUND: 404,
    SOURCE_DECISION_NOT_FOUND: 404,
    CUSTOMER_NOT_FOUND: 404,
    VARIANT_REQUIRED: 422,
    VARIANT_NOT_OF_PRODUCT: 422,
    CUSTOMER_PHONE_AMBIGUOUS: 409,
    IDEMPOTENCY_KEY_IN_FLIGHT: 409,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    BACKORDER_NOT_FOUND: 404,
    BACKORDER_NOT_CANCELLABLE: 409,
  };

  it.each(Object.entries(expected))('%s answers %i', (code, status) => {
    expect(BACKORDER_ERROR_STATUS[code as BackorderErrorCode]).toBe(status);
    expect(new BackorderError(code as BackorderErrorCode).status).toBe(status);
    expect(
      toBackorderHttpError(
        new BackorderError(code as BackorderErrorCode),
      ).getStatus(),
    ).toBe(status);
  });
});

describe('toBackorderHttpError', () => {
  it('answers a code-only body with the contract detail member', () => {
    const http = toBackorderHttpError(
      new BackorderError('PRICE_OUT_OF_DATE', { currentPriceCents: 109900 }),
    );
    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toEqual({
      statusCode: 409,
      error: 'PRICE_OUT_OF_DATE',
      message: 'PRICE_OUT_OF_DATE',
      currentPriceCents: 109900,
    });
  });

  it.each([
    ['STOCK_AVAILABLE_NOW', { availableToSell: 4 }],
    ['BACKORDER_DUPLICATE', { backorderId: 'bo-1' }],
    ['BACKORDER_NOT_CANCELLABLE', { status: 'CANCELLED' }],
  ] as const)('carries the %s detail', (code, details) => {
    expect(
      toBackorderHttpError(new BackorderError(code, details)).getResponse(),
    ).toMatchObject(details);
  });

  it('keeps the code of a shared-service DomainError (400 for invalid arguments)', () => {
    const key = toBackorderHttpError(
      new InvalidArgumentError('x', 'INVALID_IDEMPOTENCY_KEY'),
    );
    expect(key.getStatus()).toBe(400);
    expect(key.getResponse()).toMatchObject({
      error: 'INVALID_IDEMPOTENCY_KEY',
    });
    expect(
      toBackorderHttpError(
        new BusinessRuleViolationError('x', 'SOME_RULE'),
      ).getStatus(),
    ).toBe(422);
  });

  it('never leaks a raw message: unknown errors are a generic 500', () => {
    const http = toBackorderHttpError(
      new Error('connection string postgres://secret'),
    );
    expect(http.getStatus()).toBe(500);
    expect(JSON.stringify(http.getResponse())).not.toContain('secret');
    expect(http.getResponse()).toMatchObject({
      error: 'BACKORDER_REQUEST_FAILED',
    });
  });

  it('passes framework HTTP exceptions through', () => {
    const forbidden = new HttpException('Tenant context required', 403);
    expect(toBackorderHttpError(forbidden)).toBe(forbidden);
  });
});
