/**
 * SpacesStorageAdapter - DigitalOcean Spaces storage implementation.
 *
 * Implements IStoragePort using AWS S3 SDK v3.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  IStoragePort,
  UploadInput,
  UploadResult,
} from '../domain/storage.port';
import { StorageUploadFailedError } from '../domain/errors';

@Injectable()
export class SpacesStorageAdapter implements IStoragePort {
  private readonly logger = new Logger(SpacesStorageAdapter.name);

  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
  ) {}

  async upload(input: UploadInput): Promise<UploadResult> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.buffer,
        ContentType: input.mimeType,
        ContentLength: input.sizeBytes,
        ACL: 'public-read',
      });

      await this.s3Client.send(command);

      const url = this.getPublicUrl(input.key);

      return { key: input.key, url };
    } catch (error) {
      this.logger.error(
        `Failed to upload file to Spaces: ${error.message}`,
        error.stack,
      );
      throw new StorageUploadFailedError();
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      this.logger.log(`Deleted file from Spaces: ${key}`);
    } catch (error) {
      // Log but don't throw - eventual consistency for orphaned files
      this.logger.warn(
        `Failed to delete file from Spaces: ${key}`,
        error.message,
      );
    }
  }

  getPublicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }
}
