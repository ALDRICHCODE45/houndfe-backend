/**
 * Stock-guard codes of the O1 inventory journal on the global filter: the
 * response body keeps the standard `{statusCode, error, message, timestamp}`
 * envelope plus any `details` the error carries.
 */
import type { ArgumentsHost } from '@nestjs/common';
import { BusinessRuleViolationError } from '../domain/domain-error';
import {
  InsufficientStockError,
  StockVersionConflictError,
} from '../../inventory/domain/stock-journal.errors';
import {
  LotHasStockError,
  StockQuantityReadOnlyError,
  StockTrackingHasStockError,
} from '../../products/domain/product-stock.errors';
import { DomainExceptionFilter } from './domain-exception.filter';

function respond(error: Error) {
  const json = jest.fn<void, [Record<string, unknown>]>();
  const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new DomainExceptionFilter().catch(error as never, host);
  return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
}

describe('DomainExceptionFilter — stock guards (O1)', () => {
  it.each([
    ['INSUFFICIENT_STOCK', new InsufficientStockError('LOT', 'lot-1', 2, 5)],
    [
      'STOCK_VERSION_CONFLICT',
      new StockVersionConflictError('PRODUCT_UNTRACKED', 'p-1', 3),
    ],
    ['LOT_HAS_STOCK', new LotHasStockError('lot-1', 4)],
    ['STOCK_TRACKING_HAS_STOCK', new StockTrackingHasStockError('p-1', 7)],
  ])('maps %s to 409 in the standard envelope', (code, error) => {
    const { status, body } = respond(error);

    expect(status).toBe(409);
    expect(body).toMatchObject({ statusCode: 409, error: code });
    expect(typeof body?.message).toBe('string');
    expect(typeof body?.timestamp).toBe('string');
  });

  it('maps STOCK_QUANTITY_READ_ONLY to 400', () => {
    const { status, body } = respond(new StockQuantityReadOnlyError('lot'));

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'STOCK_QUANTITY_READ_ONLY',
    });
  });

  it('keeps the lot id and quantity on LOT_HAS_STOCK', () => {
    const { body } = respond(new LotHasStockError('lot-1', 4));

    expect(body).toMatchObject({ lotId: 'lot-1', quantity: 4 });
  });

  it('keeps the product id and units on STOCK_TRACKING_HAS_STOCK', () => {
    const { body } = respond(new StockTrackingHasStockError('p-1', 7));

    expect(body).toMatchObject({ productId: 'p-1', quantity: 7 });
  });

  it('leaves other business rules on their existing 422', () => {
    const { status, body } = respond(
      new BusinessRuleViolationError('nope', 'LOTS_NOT_ENABLED'),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'LOTS_NOT_ENABLED' });
  });
});
