import { HttpException } from '@nestjs/common';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { ShippingQuoteUnavailableError } from '../../shipping/quotes/domain/carrier-quote.engine';
import { ShippingQuoteError } from '../../shipping/quotes/domain/shipping-quote.errors';
import { PackagingDataMissingError } from '../../shipping/packaging/domain/order-package';
import { toShippingQuoteHttpError } from './shipping-quotes.controller';

const wire = (error: unknown) => {
  const http = toShippingQuoteHttpError(error);
  return { status: http.getStatus(), body: http.getResponse() };
};

describe('toShippingQuoteHttpError', () => {
  it.each([
    [new ShippingQuoteError('PRODUCT_NOT_FOUND', 'x'), 404],
    [new ShippingQuoteError('SHIPPING_ADDRESS_NOT_FOUND', 'x'), 404],
    [new ShippingQuoteError('INVALID_SHIPPING_DESTINATION', 'x'), 400],
    [new ShippingQuoteError('CUSTOMER_PHONE_AMBIGUOUS', 'x'), 409],
    [new ShippingQuoteError('SHIPPING_ORIGIN_NOT_CONFIGURED', 'x'), 422],
    [new ShippingQuoteUnavailableError(2), 503],
    [new InvalidArgumentError('x', 'DUPLICATE_CART_LINE'), 400],
    [new EntityNotFoundError('Product', 'p'), 404],
  ])('maps %p to %p', (error, status) => {
    expect(wire(error).status).toBe(status);
  });

  it('keeps the details flat in the envelope', () => {
    const error = new PackagingDataMissingError([
      { productId: 'p-1', variantId: null },
    ]);
    expect(wire(error)).toEqual({
      status: 422,
      body: {
        statusCode: 422,
        error: 'PACKAGING_DATA_MISSING',
        message: error.message,
        missing: [{ productId: 'p-1', variantId: null }],
      },
    });
  });

  it('never echoes an unexpected error message', () => {
    const { status, body } = wire(new Error('phone 5512345678 Calle 1'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      error: 'SHIPPING_QUOTE_FAILED',
      message: 'SHIPPING_QUOTE_FAILED',
    });
  });

  it('passes HttpExceptions through', () => {
    const error = new HttpException('nope', 403);
    expect(toShippingQuoteHttpError(error)).toBe(error);
  });
});
