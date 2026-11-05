import {
  Catch,
  HttpStatus,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReceiptUploadError } from '../../../receipts/domain/receipt-upload.errors';

/**
 * Route-scoped envelope for the receipt upload. Mirrors DomainExceptionFilter's
 * body ({ statusCode, error, message, timestamp }) with the receipt statuses,
 * and turns multer's file-size abort into RECEIPT_FILE_TOO_LARGE.
 */
@Catch(ReceiptUploadError, PayloadTooLargeException)
export class ReceiptUploadExceptionFilter implements ExceptionFilter {
  catch(
    exception: ReceiptUploadError | PayloadTooLargeException,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();
    const error =
      exception instanceof ReceiptUploadError
        ? exception
        : new ReceiptUploadError(
            'RECEIPT_FILE_TOO_LARGE',
            'Receipt file exceeds the 10 MB limit',
          );
    const status = error.httpStatus ?? HttpStatus.BAD_REQUEST;
    response.status(status).json({
      statusCode: status,
      error: error.code,
      message: error.message,
      timestamp: error.timestamp.toISOString(),
    });
  }
}
