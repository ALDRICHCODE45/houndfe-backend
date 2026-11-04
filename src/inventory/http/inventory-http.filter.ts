import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import {
  InventoryContractError,
  inventoryErrorEnvelope,
} from './inventory-contract';

/** Every failure leaves as `{statusCode, error: CODE}` with `no-store`. */
@Catch()
export class InventoryHttpFilter implements ExceptionFilter {
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
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(body.statusCode).json(body);
  }
}
