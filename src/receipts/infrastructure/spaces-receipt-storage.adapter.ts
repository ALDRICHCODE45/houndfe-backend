import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ReceiptStoragePort } from '../domain/receipt-storage.port';

/**
 * Receipt objects live in DigitalOcean Spaces with a PRIVATE ACL. Unlike
 * `src/files` (public-read catalog images) there is no public URL: the key is
 * the only handle and it is persisted, never returned to the bot.
 */
export class SpacesReceiptStorageAdapter implements ReceiptStoragePort {
  private readonly logger = new Logger(SpacesReceiptStorageAdapter.name);

  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string,
  ) {}

  async putPrivate(input: {
    key: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: input.mimeType,
        ContentLength: input.bytes.length,
        ACL: 'private',
      }),
    );
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to delete receipt object ${key}: ${(error as Error).message}`,
      );
    }
  }
}
