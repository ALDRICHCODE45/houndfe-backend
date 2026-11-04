import {
  ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import {
  InventoryContractError,
  inventoryErrorEnvelope,
} from './inventory-contract';

/** Every failure leaves as `{statusCode, error: CODE}` with `no-store`. */
@Catch()
export class InventoryHttpFilter implements ExceptionFilter {
  private readonly logger = new Logger(InventoryHttpFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    let error = exception;
    if (exception instanceof InsufficientPermissionsError)
      error = new InventoryContractError('FORBIDDEN');
    else if (exception instanceof HttpException) {
      const codes = {
        400: 'MALFORMED',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
      } as const;
      const status = exception.getStatus();
      error = new InventoryContractError(
        Object.hasOwn(codes, status)
          ? codes[status as keyof typeof codes]
          : 'INTERNAL_ERROR',
      );
    }
    const body = inventoryErrorEnvelope(error);
    if (body.statusCode >= 500) this.logUnexpected(exception, host);
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(body.statusCode).json(body);
  }

  /** Route and error only: request bodies may carry notes and are never logged. */
  private logUnexpected(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const error =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `${request.method} ${request.url} failed: ${error.name}: ${error.message}`,
      error.stack,
    );
  }
}
