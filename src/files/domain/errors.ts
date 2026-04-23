/**
 * File Domain Errors
 *
 * Specific errors for the files bounded context.
 */
import {
  DomainError,
  EntityNotFoundError,
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';

export class FileNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('File', id);
  }
}

export class FileTooLargeError extends BusinessRuleViolationError {
  constructor(maxSizeMB: number) {
    super(
      `File size exceeds maximum allowed: ${maxSizeMB} MB`,
      'FILE_TOO_LARGE',
    );
  }
}

export class UnsupportedMediaTypeError extends InvalidArgumentError {
  constructor(mimeType: string) {
    super(`Unsupported media type: ${mimeType}`, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

export class StorageUploadFailedError extends DomainError {
  constructor() {
    super('Failed to upload file to storage provider', 'STORAGE_UPLOAD_FAILED');
  }
}
