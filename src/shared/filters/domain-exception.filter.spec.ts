import { HttpStatus } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../domain/domain-error';

describe('DomainExceptionFilter', () => {
  const makeHost = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    } as any;
    return { host, status, json };
  };

  it('maps SALE_UPDATE_FORBIDDEN to 403', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'SALE_UPDATE_FORBIDDEN',
        'SALE_UPDATE_FORBIDDEN',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('maps SALE_ITEM_NOT_FOUND to 404', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'SALE_ITEM_NOT_FOUND',
        'SALE_ITEM_NOT_FOUND',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps SALE_NOT_DRAFT to 409', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('maps charge/idempotency conflict codes to 409', () => {
    const filter = new DomainExceptionFilter();

    for (const code of [
      'SALE_ALREADY_CONFIRMED',
      'PRICE_OUT_OF_DATE',
      'STOCK_INSUFFICIENT_AT_CONFIRM',
      'IDEMPOTENCY_KEY_CONFLICT',
      'IDEMPOTENCY_KEY_IN_FLIGHT',
      'SALE_FULLY_PAID',
    ]) {
      const { host, status } = makeHost();
      filter.catch(new BusinessRuleViolationError(code, code), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    }
  });

  it('keeps EntityNotFoundError as 404', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(new EntityNotFoundError('Sale', 'sale-1'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps discount validation codes to 400', () => {
    const filter = new DomainExceptionFilter();

    for (const code of [
      'INVALID_DISCOUNT_INPUT',
      'DISCOUNT_PERCENT_INVALID',
      'DISCOUNT_AMOUNT_INVALID',
    ]) {
      const { host, status } = makeHost();
      filter.catch(new BusinessRuleViolationError(code, code), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    }
  });

  it('maps payment validation errors to 422', () => {
    const filter = new DomainExceptionFilter();

    for (const code of [
      'PAYMENT_METHOD_NOT_SUPPORTED',
      'PAYMENT_AMOUNT_INSUFFICIENT',
      'PAYMENT_AMOUNT_INVALID',
      'INVALID_DUE_DATE',
    ]) {
      const { host, status } = makeHost();
      filter.catch(new BusinessRuleViolationError(code, code), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });

  it('maps customer/address not-found errors to 404', () => {
    const filter = new DomainExceptionFilter();

    for (const code of ['CUSTOMER_NOT_FOUND', 'SHIPPING_ADDRESS_NOT_FOUND']) {
      const { host, status } = makeHost();
      filter.catch(new BusinessRuleViolationError(code, code), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    }
  });

  it('maps shipping-address relation errors to 422', () => {
    const filter = new DomainExceptionFilter();

    for (const code of [
      'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
      'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
    ]) {
      const { host, status } = makeHost();
      filter.catch(new BusinessRuleViolationError(code, code), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });
});
