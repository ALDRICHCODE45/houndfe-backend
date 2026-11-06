import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../../shared/domain/domain-error';

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

/** Malformed tenant-queue cursor → 400 through DomainExceptionFilter. */
export class InvalidReceiptCursorError extends InvalidArgumentError {
  constructor() {
    super('INVALID_RECEIPT_CURSOR', 'INVALID_RECEIPT_CURSOR');
  }
}
