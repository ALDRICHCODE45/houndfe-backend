/**
 * File Domain Errors Unit Tests
 */
import {
  FileNotFoundError,
  FileTooLargeError,
  StorageUploadFailedError,
  UnsupportedMediaTypeError,
} from './errors';

describe('File Domain Errors', () => {
  describe('FileNotFoundError', () => {
    it('should create error with file ID', () => {
      const error = new FileNotFoundError('file-123');

      expect(error.message).toBe('File with id "file-123" not found');
      expect(error.code).toBe('ENTITY_NOT_FOUND');
      expect(error.name).toBe('FileNotFoundError');
    });
  });

  describe('FileTooLargeError', () => {
    it('should create error with size limit', () => {
      const error = new FileTooLargeError(5);

      expect(error.message).toBe('File size exceeds maximum allowed: 5 MB');
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.name).toBe('FileTooLargeError');
    });
  });

  describe('UnsupportedMediaTypeError', () => {
    it('should create error with unsupported MIME type', () => {
      const error = new UnsupportedMediaTypeError('text/plain');

      expect(error.message).toBe('Unsupported media type: text/plain');
      expect(error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(error.name).toBe('UnsupportedMediaTypeError');
    });
  });

  describe('StorageUploadFailedError', () => {
    it('should create error with generic message', () => {
      const error = new StorageUploadFailedError();

      expect(error.message).toBe('Failed to upload file to storage provider');
      expect(error.code).toBe('STORAGE_UPLOAD_FAILED');
      expect(error.name).toBe('StorageUploadFailedError');
    });
  });
});
