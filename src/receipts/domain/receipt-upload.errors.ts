import { DomainError } from '../../shared/domain/domain-error';

export type ReceiptUploadErrorCode =
  | 'RECEIPT_FILE_REQUIRED'
  | 'RECEIPT_FILE_TOO_LARGE'
  | 'RECEIPT_FILE_TYPE_NOT_ALLOWED'
  | 'INVALID_RECEIPT_FIELDS'
  | 'INVALID_RECEIPT_EXTRACTED'
  | 'SALE_NOT_FOUND'
  | 'SALE_ALREADY_PAID'
  | 'SALE_NOT_PAYABLE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RECEIPT_STORAGE_FAILED';

const HTTP_STATUS: Record<ReceiptUploadErrorCode, number> = {
  RECEIPT_FILE_REQUIRED: 400,
  RECEIPT_FILE_TOO_LARGE: 413,
  RECEIPT_FILE_TYPE_NOT_ALLOWED: 415,
  INVALID_RECEIPT_FIELDS: 400,
  INVALID_RECEIPT_EXTRACTED: 400,
  SALE_NOT_FOUND: 404,
  SALE_ALREADY_PAID: 409,
  SALE_NOT_PAYABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RECEIPT_STORAGE_FAILED: 502,
};

/**
 * Receipt upload failures carry their own HTTP status so the upload route can
 * answer the documented codes without widening the global DomainExceptionFilter
 * table (which maps unknown business codes to 422).
 */
export class ReceiptUploadError extends DomainError {
  readonly httpStatus: number;

  constructor(code: ReceiptUploadErrorCode, message: string) {
    super(message, code);
    this.httpStatus = HTTP_STATUS[code];
  }
}
