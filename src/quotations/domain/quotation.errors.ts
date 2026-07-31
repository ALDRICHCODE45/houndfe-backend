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
