import { EntityAlreadyExistsError } from '../../shared/domain/domain-error';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { CustomerHasActiveBackordersError } from './customer-has-active-backorders.error';

describe('CustomerHasActiveBackordersError', () => {
  it('carries the contract code and the Spanish message', () => {
    const error = new CustomerHasActiveBackordersError();
    expect(error.code).toBe('CUSTOMER_HAS_ACTIVE_BACKORDERS');
    expect(error.message).toBe(
      'El cliente tiene pedidos por reposición activos',
    );
    expect(error).toBeInstanceOf(EntityAlreadyExistsError);
  });

  it('answers 409 with the same body shape as the other domain 409s', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    };
    new DomainExceptionFilter().catch(
      new CustomerHasActiveBackordersError(),
      host as never,
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'CUSTOMER_HAS_ACTIVE_BACKORDERS',
      message: 'El cliente tiene pedidos por reposición activos',
      timestamp: expect.any(String) as string,
    });
  });
});
