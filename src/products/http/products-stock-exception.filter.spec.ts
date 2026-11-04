/**
 * The products module's filter answers the stock-guard codes the global
 * `DomainExceptionFilter` does not know and delegates everything else to it.
 */
import type { ArgumentsHost } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  LotHasStockError,
  StockQuantityReadOnlyError,
} from '../domain/product-stock.errors';
import { ProductsStockExceptionFilter } from './products-stock-exception.filter';

describe('ProductsStockExceptionFilter', () => {
  function respond(error: Error) {
    const json = jest.fn<void, [Record<string, unknown>]>();
    const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    new ProductsStockExceptionFilter().catch(error as never, host);
    return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
  }

  it('maps LOT_HAS_STOCK to 409 in the standard envelope with its details', () => {
    const { status, body } = respond(new LotHasStockError('lot-1', 4));
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'LOT_HAS_STOCK',
      lotId: 'lot-1',
      quantity: 4,
    });
    expect(typeof body?.message).toBe('string');
    expect(typeof body?.timestamp).toBe('string');
  });

  it('delegates STOCK_QUANTITY_READ_ONLY to the global mapping (400)', () => {
    const { status, body } = respond(new StockQuantityReadOnlyError('lot'));
    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'STOCK_QUANTITY_READ_ONLY',
    });
  });

  it('leaves every other domain error on its existing status', () => {
    const { status, body } = respond(
      new BusinessRuleViolationError('nope', 'LOTS_NOT_ENABLED'),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'LOTS_NOT_ENABLED' });
  });
});
