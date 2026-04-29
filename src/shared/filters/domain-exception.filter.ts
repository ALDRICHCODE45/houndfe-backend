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
} from '../domain/domain-error';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: DomainError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.getHttpStatus(exception);

    this.logger.warn(`[${exception.code}] ${exception.message}`);

    response.status(status).json({
      statusCode: status,
      error: exception.code,
      message: exception.message,
      timestamp: exception.timestamp.toISOString(),
    });
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
    if (exception.code === 'SALE_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'SALE_ITEM_NOT_FOUND') return HttpStatus.NOT_FOUND;
    if (exception.code === 'SALE_NOT_DRAFT') return HttpStatus.CONFLICT;
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
