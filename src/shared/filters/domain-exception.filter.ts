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
   * EntityNotFoundError     → 404
   * EntityAlreadyExistsError → 409
   * BusinessRuleViolationError → 422
   * InvalidArgumentError    → 400
   * Default                 → 500
   */
  private getHttpStatus(exception: DomainError): number {
    if (exception instanceof EntityNotFoundError) return HttpStatus.NOT_FOUND;
    if (exception instanceof EntityAlreadyExistsError)
      return HttpStatus.CONFLICT;
    if (exception instanceof BusinessRuleViolationError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (exception instanceof InvalidArgumentError)
      return HttpStatus.BAD_REQUEST;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
