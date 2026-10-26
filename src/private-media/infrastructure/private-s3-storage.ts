import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  PRIVATE_MEDIA_MIME_TYPES,
  PrivateMediaAsset,
} from '../domain/private-media';
import {
  PrivateMediaConfig,
  resolvePrivateMediaConfig,
} from './private-media-config';

type StorageMetadata = Pick<
  PrivateMediaAsset,
  'storageKey' | 'mimeType' | 'sizeBytes'
>;

/** Internal bytes only. Authorization and persisted linkage belong to the caller. */
export class PrivateS3Storage {
  private readonly client: S3Client;
  private readonly config: PrivateMediaConfig;

  constructor(config: PrivateMediaConfig) {
    const validated =
      config &&
      resolvePrivateMediaConfig({
        PRIVATE_MEDIA_ENDPOINT: config.endpoint,
        PRIVATE_MEDIA_REGION: config.region,
        PRIVATE_MEDIA_BUCKET: config.bucket,
        PRIVATE_MEDIA_ACCESS_KEY_ID: config.credentials?.accessKeyId,
        PRIVATE_MEDIA_SECRET_ACCESS_KEY: config.credentials?.secretAccessKey,
        PRIVATE_MEDIA_MAX_BYTES: config.maxBytes,
      });
    if (!validated || config.maxBytes === undefined)
      throw new Error('Invalid private storage configuration');
    this.config = validated;
    this.client = new S3Client({
      endpoint: validated.endpoint,
      region: validated.region,
      credentials: validated.credentials,
      maxAttempts: 1,
    });
  }

  private validate(metadata: StorageMetadata): void {
    this.validateKey(metadata.storageKey);
    if (
      !PRIVATE_MEDIA_MIME_TYPES.includes(metadata.mimeType) ||
      !Number.isInteger(metadata.sizeBytes) ||
      metadata.sizeBytes <= 0 ||
      metadata.sizeBytes > this.config.maxBytes
    )
      throw new Error('Invalid private media metadata');
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || !key.trim())
      throw new Error('Invalid private storage key');
  }

  async put(metadata: StorageMetadata, bytes: Buffer): Promise<void> {
    this.validate(metadata);
    if (!Buffer.isBuffer(bytes) || bytes.length !== metadata.sizeBytes)
      throw new Error('Private media byte length mismatch');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: metadata.storageKey,
        Body: Buffer.from(bytes),
        ContentType: metadata.mimeType,
        ContentLength: metadata.sizeBytes,
        ACL: 'private',
      }),
    );
  }

  /** Compensation for a caller-owned new attempt only; never enumerate or GC. */
  async remove(storageKey: string): Promise<void> {
    this.validateKey(storageKey);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      }),
    );
  }
}
