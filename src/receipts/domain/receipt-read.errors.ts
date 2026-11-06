import { DomainError } from '../../shared/domain/domain-error';

export type ReceiptReadErrorCode =
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_FILE_NOT_AVAILABLE'
  | 'RECEIPT_FILE_PURGED'
  | 'RECEIPT_STORAGE_FAILED';

const HTTP_STATUS: Record<ReceiptReadErrorCode, number> = {
  RECEIPT_NOT_FOUND: 404,
  RECEIPT_FILE_NOT_AVAILABLE: 404,
  RECEIPT_FILE_PURGED: 410,
  RECEIPT_STORAGE_FAILED: 502,
};

/**
 * Receipt read failures (staff file routes and the bot outcome poll). They
 * carry their own HTTP status, like ReceiptUploadError, so the routes answer
 * the documented codes through ReceiptReadExceptionFilter.
 */
export class ReceiptReadError extends DomainError {
  readonly httpStatus: number;

  constructor(code: ReceiptReadErrorCode, message: string) {
    super(message, code);
    this.httpStatus = HTTP_STATUS[code];
  }
}
