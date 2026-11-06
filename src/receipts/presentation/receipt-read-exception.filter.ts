import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReceiptReadError } from '../domain/receipt-read.errors';

/**
 * Route-scoped envelope for receipt reads. Same body as DomainExceptionFilter
 * ({ statusCode, error, message, timestamp }) with the receipt statuses.
 */
@Catch(ReceiptReadError)
export class ReceiptReadExceptionFilter implements ExceptionFilter {
  catch(exception: ReceiptReadError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(exception.httpStatus)
      .setHeader('Cache-Control', 'no-store')
      .json({
        statusCode: exception.httpStatus,
        error: exception.code,
        message: exception.message,
        timestamp: exception.timestamp.toISOString(),
      });
  }
}
