import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

export class InvalidDueDateError extends BusinessRuleViolationError {
  constructor() {
    super('INVALID_DUE_DATE', 'INVALID_DUE_DATE');
  }
}

export class SaleFullyPaidError extends BusinessRuleViolationError {
  constructor() {
    super('SALE_FULLY_PAID', 'SALE_FULLY_PAID');
  }
}

export class SellerNotFoundError extends BusinessRuleViolationError {
  constructor() {
    super('SELLER_NOT_FOUND', 'SELLER_NOT_FOUND');
  }
}

export class SaleNotCancellableError extends BusinessRuleViolationError {
  constructor() {
    super('SALE_NOT_CANCELLABLE', 'SALE_NOT_CANCELLABLE');
  }
}

export class SaleDeliveredCannotCancelError extends BusinessRuleViolationError {
  constructor() {
    super('SALE_DELIVERED_CANNOT_CANCEL', 'SALE_DELIVERED_CANNOT_CANCEL');
  }
}
