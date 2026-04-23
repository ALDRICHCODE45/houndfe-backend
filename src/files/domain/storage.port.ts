/**
 * IStoragePort - Port for object storage operations.
 *
 * Abstraction over remote storage providers (DigitalOcean Spaces, S3, etc).
 */

export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface UploadInput {
  buffer: Buffer;
  key: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadResult {
  key: string;
  url: string;
}

export interface IStoragePort {
  /**
   * Upload a file to remote storage.
   * @throws StorageUploadFailedError if upload fails
   */
  upload(input: UploadInput): Promise<UploadResult>;

  /**
   * Delete a file from remote storage.
   * @throws Error if deletion fails (logged, not thrown to caller)
   */
  delete(key: string): Promise<void>;

  /**
   * Generate public URL for a storage key.
   */
  getPublicUrl(key: string): string;
}
