import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';
import {
  ReceiptNotActionableError,
  SaleNotReviewableError,
} from './receipt-review.errors';

describe('receipt review domain errors', () => {
  it('creates ReceiptNotActionableError with the receipt guard code and message', () => {
    const error = new ReceiptNotActionableError();

    expect(error).toBeInstanceOf(BusinessRuleViolationError);
    expect(error.message).toBe('RECEIPT_NOT_ACTIONABLE');
    expect(error.code).toBe('RECEIPT_NOT_ACTIONABLE');
  });

  it('creates SaleNotReviewableError with the sale guard code and message', () => {
    const error = new SaleNotReviewableError();

    expect(error).toBeInstanceOf(BusinessRuleViolationError);
    expect(error.message).toBe('SALE_NOT_REVIEWABLE');
    expect(error.code).toBe('SALE_NOT_REVIEWABLE');
  });
});
