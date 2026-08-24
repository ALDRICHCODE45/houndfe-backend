import { HttpStatus } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
  BatchDeleteValidationError,
} from '../domain/domain-error';
import { TimeOffInvalidDateRangeError } from '../../employees/domain/errors/time-off-invalid-date-range.error';
import { TimeOffInvalidTransitionError } from '../../employees/domain/errors/time-off-invalid-transition.error';

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

    for (const code of [
      'CUSTOMER_NOT_FOUND',
      'SELLER_NOT_FOUND',
      'SHIPPING_ADDRESS_NOT_FOUND',
      'COMMENT_NOT_FOUND',
    ]) {
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

  it('maps comment author forbidden to 403', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'COMMENT_AUTHOR_FORBIDDEN',
        'COMMENT_AUTHOR_FORBIDDEN',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('maps TIME_OFF_INVALID_DATE_RANGE to 400', () => {
    const filter = new DomainExceptionFilter();
    const { host, status, json } = makeHost();

    filter.catch(
      new TimeOffInvalidDateRangeError('2026-07-10', '2026-07-01'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'TIME_OFF_INVALID_DATE_RANGE',
      }),
    );
  });

  it('maps TIME_OFF_INVALID_TRANSITION to 409', () => {
    const filter = new DomainExceptionFilter();
    const { host, status, json } = makeHost();

    filter.catch(new TimeOffInvalidTransitionError('APPROVED', 'cancel'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        error: 'TIME_OFF_INVALID_TRANSITION',
      }),
    );
  });

  // ── batch-delete ──────────────────────────────────────────────

  it('maps BATCH_DELETE_NOT_FOUND to 404', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'BATCH_DELETE_NOT_FOUND',
        'BATCH_DELETE_NOT_FOUND',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps BATCH_DELETE_FK_CONSTRAINT to 409', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'BATCH_DELETE_FK_CONSTRAINT',
        'BATCH_DELETE_FK_CONSTRAINT',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('maps PROMOTION_REFERENCED_BY_SALE to 409', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'PROMOTION_REFERENCED_BY_SALE',
        'PROMOTION_REFERENCED_BY_SALE',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('serializes offendingIds + reason on BatchDeleteValidationError', () => {
    const filter = new DomainExceptionFilter();
    const { host, status, json } = makeHost();

    const err = new BatchDeleteValidationError(
      ['p2', 'p4'],
      'Promotion referenced by a SaleItem',
      'PROMOTION_REFERENCED_BY_SALE',
    );
    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        error: 'PROMOTION_REFERENCED_BY_SALE',
        offendingIds: ['p2', 'p4'],
        reason: 'Promotion referenced by a SaleItem',
      }),
    );
  });

  it('BatchDeleteValidationError without overriding code uses BATCH_DELETE_FK_CONSTRAINT', () => {
    const filter = new DomainExceptionFilter();
    const { host, status, json } = makeHost();

    const err = new BatchDeleteValidationError(['x'], 'fk blocker');
    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'BATCH_DELETE_FK_CONSTRAINT',
        offendingIds: ['x'],
      }),
    );
  });

  // ── Q1 / WU1 — PaymentDetail codes + D7 details spread ─────────────────

  it('maps NO_ACTIVE_PAYMENT_DETAIL to 404', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError(
        'NO_ACTIVE_PAYMENT_DETAIL',
        'NO_ACTIVE_PAYMENT_DETAIL',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps DUPLICATE_CLABE to 409', () => {
    const filter = new DomainExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(
      new BusinessRuleViolationError('DUPLICATE_CLABE', 'DUPLICATE_CLABE'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('spreads BusinessRuleViolationError.details into the response body (D7)', () => {
    const filter = new DomainExceptionFilter();
    const { host, status, json } = makeHost();

    // Use DUPLICATE_CLABE (Q1 / WU1) for the status code, but the payload
    // shape is what PROMO_RE_QUOTE will eventually carry too (WU3 lands
    // its status mapping). The spread mechanic is identical and code-agnostic.
    const err = new BusinessRuleViolationError(
      'DUPLICATE_CLABE',
      'DUPLICATE_CLABE',
      {
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
    );
    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        error: 'DUPLICATE_CLABE',
        message: 'DUPLICATE_CLABE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      }),
    );
  });

  it('omits `details` spread when BusinessRuleViolationError has none', () => {
    const filter = new DomainExceptionFilter();
    const { host, json } = makeHost();

    const err = new BusinessRuleViolationError('X', 'X');
    filter.catch(err, host);

    const calledWith = (json.mock.calls[0]?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    expect(calledWith).not.toHaveProperty('recomputedTotalCents');
    expect(calledWith).not.toHaveProperty('expectedTotalCents');
    expect(calledWith).not.toHaveProperty('discountCents');
  });
});
