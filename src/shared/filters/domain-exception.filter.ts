/**
 * DomainExceptionFilter - Maps domain errors to HTTP responses.
 *
 * This is the bridge between framework-agnostic domain errors
 * and NestJS HTTP responses. The domain throws pure errors,
 * this filter translates them to proper HTTP status codes.
 *
 * WHY: Domain should not know about HTTP. This filter lives
 * in infrastructure and handles the translation.
 */
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  DomainError,
  EntityNotFoundError,
  EntityAlreadyExistsError,
  BusinessRuleViolationError,
  InvalidArgumentError,
  InvalidCredentialsError,
  UserInactiveError,
  InvalidRefreshTokenError,
  InsufficientPermissionsError,
  SystemRoleProtectedError,
  BatchDeleteValidationError,
} from '../domain/domain-error';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: DomainError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.getHttpStatus(exception);

    this.logger.warn(`[${exception.code}] ${exception.message}`);

    // R6 (response contract): offending IDs + reason must survive into
    // the response body for batch-delete callers. `any` is intentional —
    // the response shape is open for this one extra field.
    const body: Record<string, unknown> = {
      statusCode: status,
      error: exception.code,
      message: exception.message,
      timestamp: exception.timestamp.toISOString(),
    };

    if (exception instanceof BatchDeleteValidationError) {
      body.offendingIds = exception.offendingIds;
      if (exception.message) {
        body.reason = exception.message;
      }
    }

    // D7 — BusinessRuleViolationError carries an optional `details` payload
    // (e.g. PROMO_RE_QUOTE returns { recomputedTotalCents, expectedTotalCents,
    // discountCents }). Spread it into the response body so the caller gets
    // a flat envelope with the contextual fields directly readable. The
    // spread uses Object.assign to keep `body` typed (Record<string, unknown>)
    // and not lose its prior keys.
    if (
      exception instanceof BusinessRuleViolationError &&
      exception.details
    ) {
      Object.assign(body, exception.details);
    }

    response.status(status).json(body);
  }

  /**
   * Maps domain error types to HTTP status codes.
   *
   * EntityNotFoundError        → 404
   * EntityAlreadyExistsError   → 409
   * BusinessRuleViolationError → 422
   * InvalidArgumentError       → 400
   * InvalidCredentialsError    → 401
   * UserInactiveError          → 401
   * InvalidRefreshTokenError   → 401
   * InsufficientPermissionsError → 403
   * SystemRoleProtectedError   → 422
   * Default                    → 500
   */
  private getHttpStatus(exception: DomainError): number {
    if (exception.code === 'SALE_UPDATE_FORBIDDEN') return HttpStatus.FORBIDDEN;
    if (exception.code === 'COMMENT_AUTHOR_FORBIDDEN')
      return HttpStatus.FORBIDDEN;
    if (exception.code === 'SALE_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'SALE_ITEM_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'CUSTOMER_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'SELLER_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'COMMENT_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'SHIPPING_ADDRESS_NOT_FOUND')
      return HttpStatus.NOT_FOUND;
    if (exception.code === 'SALE_NOT_DRAFT') return HttpStatus.CONFLICT;
    if (exception.code === 'SALE_ALREADY_CONFIRMED') return HttpStatus.CONFLICT;
    if (exception.code === 'PRICE_LIST_NOT_FOUND')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'PRICE_OUT_OF_DATE') return HttpStatus.CONFLICT;
    if (exception.code === 'STOCK_INSUFFICIENT_AT_CONFIRM')
      return HttpStatus.CONFLICT;
    if (exception.code === 'IDEMPOTENCY_KEY_CONFLICT')
      return HttpStatus.CONFLICT;
    if (exception.code === 'IDEMPOTENCY_KEY_IN_FLIGHT')
      return HttpStatus.CONFLICT;
    if (exception.code === 'SALE_FULLY_PAID') return HttpStatus.CONFLICT;
    if (exception.code === 'SALE_NOT_CANCELLABLE') return HttpStatus.CONFLICT;
    if (exception.code === 'SALE_DELIVERED_CANNOT_CANCEL')
      return HttpStatus.CONFLICT;
    if (exception.code === 'PAYMENT_METHOD_NOT_SUPPORTED')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'PAYMENT_AMOUNT_INSUFFICIENT')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'PAYMENT_AMOUNT_INVALID')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'SHIPPING_ADDRESS_REQUIRES_CUSTOMER')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'INVALID_DUE_DATE')
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception.code === 'DUPLICATE_EMPLOYEE_NUMBER')
      return HttpStatus.CONFLICT;
    if (exception.code === 'EMPLOYEE_ALREADY_TERMINATED')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'EMPLOYEE_NOT_TERMINATED')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'MANAGER_SELF_REFERENCE')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'TIME_OFF_INVALID_DATE_RANGE')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'TIME_OFF_INVALID_TRANSITION')
      return HttpStatus.CONFLICT;
    if (exception.code === 'INVALID_PRICE_OVERRIDE_INPUT')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'INVALID_PRICE_LIST_FOR_ITEM')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'INVALID_DISCOUNT_INPUT')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'DISCOUNT_PERCENT_INVALID')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'DISCOUNT_AMOUNT_INVALID')
      return HttpStatus.BAD_REQUEST;

    // ── batch-delete ──
    if (exception.code === 'BATCH_DELETE_NOT_FOUND')
      return HttpStatus.NOT_FOUND;
    if (exception.code === 'BATCH_DELETE_FK_CONSTRAINT')
      return HttpStatus.CONFLICT;
    if (exception.code === 'PROMOTION_REFERENCED_BY_SALE')
      return HttpStatus.CONFLICT;

    // ── PaymentDetail (Q1 / WU1) ──
    if (exception.code === 'NO_ACTIVE_PAYMENT_DETAIL')
      return HttpStatus.NOT_FOUND;
    if (exception.code === 'DUPLICATE_CLABE')
      return HttpStatus.CONFLICT;

    // ── Custom Payment Methods (custom-payment-methods / WU2 — D9) ──
    // The sales-spec asserts specific codes/statuses for the
    // charge/collection resolver path:
    //   PAYMENT_METHOD_NOT_FOUND        → 404
    //   INACTIVE_PAYMENT_METHOD         → 409
    //   PAYMENT_METHOD_CATEGORY_MISMATCH → 400
    //   DUPLICATE_NAME                  → 409 (admin CRUD path — same
    //                                     code as the @@unique([tenantId,
    //                                     name]) constraint violation).
    if (exception.code === 'PAYMENT_METHOD_NOT_FOUND')
      return HttpStatus.NOT_FOUND;
    if (exception.code === 'INACTIVE_PAYMENT_METHOD')
      return HttpStatus.CONFLICT;
    if (exception.code === 'PAYMENT_METHOD_CATEGORY_MISMATCH')
      return HttpStatus.BAD_REQUEST;
    if (exception.code === 'DUPLICATE_NAME')
      return HttpStatus.CONFLICT;

            // ── delivery-routes / WU2 — ADR-7 partial unique index race ──
        // The service pre-check and the DB partial unique index both encode
        // the "one sale per ACTIVE route" invariant; map to 409 (conflict),
        // not the generic 422.
        if (exception.code === 'DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE')
          return HttpStatus.CONFLICT;

// ── Q2 / WU3 — promotion re-quote ──
    // The `details` payload `{ recomputedTotalCents, expectedTotalCents,
    // discountCents }` is spread into the response body by the
    // BusinessRuleViolationError branch above (D7).
    if (exception.code === 'PROMO_RE_QUOTE')
      return HttpStatus.CONFLICT;

    if (exception instanceof EntityNotFoundError) return HttpStatus.NOT_FOUND;
    if (exception instanceof EntityAlreadyExistsError)
      return HttpStatus.CONFLICT;
    if (exception instanceof BusinessRuleViolationError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception instanceof InvalidArgumentError)
      return HttpStatus.BAD_REQUEST;
    if (exception instanceof InvalidCredentialsError)
      return HttpStatus.UNAUTHORIZED;
    if (exception instanceof UserInactiveError) return HttpStatus.UNAUTHORIZED;
    if (exception instanceof InvalidRefreshTokenError)
      return HttpStatus.UNAUTHORIZED;
    if (exception instanceof InsufficientPermissionsError)
      return HttpStatus.FORBIDDEN;
    if (exception instanceof SystemRoleProtectedError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
