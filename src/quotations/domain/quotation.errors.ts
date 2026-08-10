import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';
import type { QuotationStatus } from './quotation.entity';

/**
 * Raised when a mutation (addItem, removeItem, updateItemQuantity,
 * clearItems, assignCustomer, setGlobalPriceList, setExpiry) is called
 * on a quotation that is not in DRAFT status. Mirrors the Sale's
 * `SALE_NOT_DRAFT` business rule violation.
 */
export class QuotationNotDraftError extends BusinessRuleViolationError {
  constructor(currentStatus: QuotationStatus) {
    super(
      `Quotation is in ${currentStatus} status; mutation is not allowed`,
      'QUOTATION_NOT_DRAFT',
    );
  }
}

/**
 * Raised when `updateItemQuantity` or `removeItem` is called with an
 * item id that doesn't belong to the aggregate.
 */
export class QuotationItemNotFoundError extends BusinessRuleViolationError {
  constructor(itemId: string) {
    super(
      `QuotationItem with id "${itemId}" not found`,
      'QUOTATION_ITEM_NOT_FOUND',
    );
  }
}

/**
 * Raised by the repository when `findById` cannot find the quotation in
 * the current tenant scope. The HTTP layer translates this to a 404.
 */
export class QuotationNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('Quotation', id);
  }
}

/**
 * WU4 — Raised by `Quotation.send()` when the entity has zero items.
 * The HTTP layer maps this to a 422 (the spec scenario "Send on
 * quotation with no items is rejected"). Distinct from the
 * non-DRAFT / has-no-customer errors because the domain rule is
 * "a quotation must carry at least one line to be sent", not a
 * state-machine guard.
 */
export class QuotationHasNoItemsError extends BusinessRuleViolationError {
  constructor(id: string) {
    super(
      `Quotation ${id} cannot be sent because it has no items`,
      'QUOTATION_HAS_NO_ITEMS',
    );
  }
}

/**
 * WU4 — Raised by `QuotationsService.send()` when the assigned customer
 * has no email address on file. The HTTP layer maps this to a 422 with
 * code `QUOTATION_CUSTOMER_HAS_NO_EMAIL` (spec scenario "Customer has
 * no email — rejected with 422"). A quotation must carry an email-
 * reachable customer to be sent.
 */
export class QuotationCustomerHasNoEmailError extends BusinessRuleViolationError {
  constructor(id: string) {
    super(
      `Quotation ${id} cannot be sent: assigned customer has no email address`,
      'QUOTATION_CUSTOMER_HAS_NO_EMAIL',
    );
  }
}

/**
 * Raised by `QuotationsService.assignSeller` when the target seller user
 * does not exist in the tenant. The HTTP layer maps this to a 404 via
 * the `SELLER_NOT_FOUND` code (see `DomainExceptionFilter`).
 */
export class QuotationSellerNotFoundError extends BusinessRuleViolationError {
  constructor() {
    super('SELLER_NOT_FOUND', 'SELLER_NOT_FOUND');
  }
}
