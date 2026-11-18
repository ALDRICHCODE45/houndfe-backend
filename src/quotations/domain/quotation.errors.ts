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

// ── quotation-sale-conversion / T1 ──────────────────────────────────
//
// Every conversion rejection is a `BusinessRuleViolationError` with a
// stable `code`. None of the codes below has a dedicated mapping in the
// shared `DomainExceptionFilter`, so they surface as HTTP 422 with the
// `details` payload spread into the response body (D7).

/** Quotation is EXPIRED (persisted, or lazily past `expiresAt`). */
export class QuotationExpiredError extends BusinessRuleViolationError {
  constructor(id: string) {
    super(
      `Quotation ${id} is expired; renew it before converting`,
      'QUOTATION_EXPIRED',
    );
  }
}

/** Quotation is CANCELLED (terminal). */
export class QuotationCancelledError extends BusinessRuleViolationError {
  constructor(id: string) {
    super(`Quotation ${id} is cancelled`, 'QUOTATION_CANCELLED');
  }
}

/**
 * Quotation already became a sale. `details.saleId` carries the existing
 * sale so the caller can open it instead of converting again.
 */
export class QuotationAlreadyConvertedError extends BusinessRuleViolationError {
  constructor(id: string, saleId: string | null) {
    super(
      `Quotation ${id} was already converted to a sale`,
      'QUOTATION_ALREADY_CONVERTED',
      { saleId },
    );
  }
}

/** Why a single line cannot be carried into a draft sale. */
export type ConversionLineProblemReason =
  | 'PRODUCT_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'PRODUCT_NOT_SELLABLE'
  | 'INSUFFICIENT_STOCK';

export interface ConversionLineProblem {
  /** Quotation item id (quotation → sale) or sale item id (sale → quotation). */
  lineId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  reason: ConversionLineProblemReason;
  requestedQuantity: number;
  /** Sellable stock when `reason === 'INSUFFICIENT_STOCK'`, else null. */
  availableQuantity: number | null;
}

/** One or more quotation lines cannot become sale lines (S5). */
export class QuotationLinesUnavailableError extends BusinessRuleViolationError {
  constructor(lines: ConversionLineProblem[]) {
    super(
      `${lines.length} quotation line(s) cannot be converted to a sale`,
      'QUOTATION_LINES_UNAVAILABLE',
      { lines },
    );
  }
}

/** One or more sale lines cannot be priced on a quotation. */
export class SaleLinesUnavailableError extends BusinessRuleViolationError {
  constructor(lines: ConversionLineProblem[]) {
    super(
      `${lines.length} sale line(s) cannot be copied to a quotation`,
      'SALE_LINES_UNAVAILABLE',
      { lines },
    );
  }
}

/**
 * The POS draft sale cannot be discarded into a quotation (S3). Codes:
 *   - `SALE_HAS_NO_ITEMS`        — nothing to quote.
 *   - `SALE_HAS_PAYMENTS`        — payments / refunds / receipt evidence exist.
 *   - `SALE_HAS_STOCK_MOVEMENTS` — inventory was already touched.
 *   - `SALE_NOT_DISCARDABLE`     — other dependents (delivery route stop,
 *                                  promotion capacity usage).
 */
export class SaleNotDiscardableError extends BusinessRuleViolationError {
  constructor(
    code:
      | 'SALE_HAS_NO_ITEMS'
      | 'SALE_HAS_PAYMENTS'
      | 'SALE_HAS_STOCK_MOVEMENTS'
      | 'SALE_NOT_DISCARDABLE',
    saleId: string,
  ) {
    super(`Sale ${saleId} cannot be converted to a quotation: ${code}`, code);
  }
}
