/**
 * Maps the products module's stock-guard codes that the global
 * `DomainExceptionFilter` does not know (it would answer 422) and delegates
 * everything else to it, so the envelope stays the same
 * `{ statusCode, error: CODE, message, timestamp }`.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  BusinessRuleViolationError,
  DomainError,
} from '../../shared/domain/domain-error';
import { LOT_HAS_STOCK } from '../domain/product-stock.errors';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';

@Catch(DomainError)
export class ProductsStockExceptionFilter implements ExceptionFilter {
  private readonly fallback = new DomainExceptionFilter();

  catch(exception: DomainError, host: ArgumentsHost) {
    if (exception.code !== LOT_HAS_STOCK) {
      return this.fallback.catch(exception, host);
    }
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.CONFLICT)
      .json({
        statusCode: HttpStatus.CONFLICT,
        error: exception.code,
        message: exception.message,
        timestamp: exception.timestamp.toISOString(),
        ...(exception instanceof BusinessRuleViolationError
          ? exception.details
          : {}),
      });
  }
}
