import { Logger, type ArgumentsHost } from '@nestjs/common';
import { InventoryContractError } from './inventory-contract';
import { InventoryHttpFilter } from './inventory-http.filter';

function host(url = '/inventory/adjustments') {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = { method: 'POST', url, body: { secret: 'never-log' } };
  const value = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { value, response };
}

describe('InventoryHttpFilter logging', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => errorSpy.mockRestore());

  it('logs unexpected failures and keeps the 500 envelope', () => {
    const { value, response } = host();
    new InventoryHttpFilter().catch(new Error('db exploded'), value);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      error: 'INTERNAL_ERROR',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, stack] = errorSpy.mock.calls[0] as [string, string];
    expect(message).toContain('POST /inventory/adjustments');
    expect(message).toContain('db exploded');
    expect(stack).toContain('Error: db exploded');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('never-log');
  });

  it('does not log expected contract errors', () => {
    const { value, response } = host();
    new InventoryHttpFilter().catch(
      new InventoryContractError('INSUFFICIENT_STOCK'),
      value,
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
