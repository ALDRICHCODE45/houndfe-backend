import { Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  ReceiptStoragePort,
  ReceiptStoredObject,
} from '../domain/receipt-storage.port';

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

  async getPrivate(key: string): Promise<ReceiptStoredObject | null> {
    try {
      const output = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        body: output.Body as Readable,
        contentLength: output.ContentLength ?? null,
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async delete(key: string): Promise<void> {
    try {
      await this.remove(key);
    } catch (error) {
      this.logger.warn(
        `Failed to delete receipt object ${key}: ${(error as Error).message}`,
      );
    }
  }
}
