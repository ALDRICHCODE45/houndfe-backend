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

/**
 * delivery-routes / WU2 — narrow Sale mirror error.
 *
 * Thrown by `Sale.markDelivered()` when the route check-in flow tries to
 * flip a Sale that is NOT in the `CONFIRMED` lifecycle status. The single
 * writer of `deliveryStatus='DELIVERED'` is the route check-in flow
 * (design ADR-2 + ADR-3); this error guards the transition at the aggregate
 * boundary so the wrong-state sale is rejected before the Prisma write.
 *
 * Code: `SALE_NOT_DELIVERABLE` (HTTP 422 via the DomainExceptionFilter's
 * `BusinessRuleViolationError` default branch).
 */
export class SaleNotDeliverableError extends BusinessRuleViolationError {
  constructor() {
    super('SALE_NOT_DELIVERABLE', 'SALE_NOT_DELIVERABLE');
  }
}
