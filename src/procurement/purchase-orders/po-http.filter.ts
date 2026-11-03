import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import {
  PurchaseOrderContractError,
  purchaseOrderErrorEnvelope,
} from './po-contract';

@Catch()
export class PurchaseOrderHttpFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    let error = exception;
    if (exception instanceof InsufficientPermissionsError)
      error = new PurchaseOrderContractError('FORBIDDEN');
    else if (exception instanceof HttpException) {
      const codes = {
        400: 'MALFORMED',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
      } as const;
      const status = exception.getStatus();
      const code = Object.hasOwn(codes, status)
        ? codes[status as keyof typeof codes]
        : 'INTERNAL_ERROR';
      error = new PurchaseOrderContractError(code);
    }
    const body = purchaseOrderErrorEnvelope(error);
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(body.statusCode).json(body);
  }
}
