import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';

export class ReceiptNotActionableError extends BusinessRuleViolationError {
  constructor() {
    super('RECEIPT_NOT_ACTIONABLE', 'RECEIPT_NOT_ACTIONABLE');
  }
}

export class SaleNotReviewableError extends BusinessRuleViolationError {
  constructor() {
    super('SALE_NOT_REVIEWABLE', 'SALE_NOT_REVIEWABLE');
  }
}
