/**
 * DOMAIN ERRORS: DeliveryRoute — bounded-context error vocabulary
 * (delivery-routes / WU2).
 *
 * Mirrors the `payment-detail` / `quotation` precedent: each error is a
 * pure domain subclass of `BusinessRuleViolationError` or
 * `EntityNotFoundError`, with a stable `code` that the global
 * `DomainExceptionFilter` maps to an HTTP status code (see design §9
 * error table).
 *
 * Codes are returned on the wire inside the response body's `error`
 * field — controllers and the FE contract depend on these strings.
 */
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';

/**
 * 422 — illegal lifecycle transition (e.g. cancelling a COMPLETED route,
 * starting an ACTIVE route, check-in against DRAFT). Carries the
 * attempted transition in `details` for the FE contract.
 */
export class DeliveryRouteInvalidTransitionError extends BusinessRuleViolationError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, 'DELIVERY_ROUTE_INVALID_TRANSITION', details);
  }
}

/**
 * 409 — the application pre-check or the DB partial-unique index
 * detected that one of the route's sales is already on another ACTIVE
 * route. Mapped from P2002 on the `(tenantId, saleId) WHERE activeRouteId
 * IS NOT NULL` index (design ADR-7).
 */
export class DeliveryRouteSaleAlreadyInActiveRouteError extends BusinessRuleViolationError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(
      message,
      'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE',
      details,
    );
  }
}

/**
 * 422 — a sale on the route is not eligible for delivery: either its
 * `deliveryStatus` is outside `{PENDING, SHIPPED}` or its
 * `shippingAddressId` is null. Re-checked on `start()` (the chatbot's
 * `SHIPPED` writer is orthogonal and can flip a stop's eligibility
 * between `create` and `start`).
 */
export class DeliveryRouteSaleNotEligibleError extends BusinessRuleViolationError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, 'DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE', details);
  }
}

/**
 * 404 — the route (or one of its stops) was not found in the caller's
 * tenant. Cross-tenant access surfaces as 404 (never 403) so presence
 * is indistinguishable across tenants.
 */
export class DeliveryRouteNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('DeliveryRoute', id);
  }
}
