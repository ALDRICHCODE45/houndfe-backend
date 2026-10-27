import { randomUUID } from 'node:crypto';
import {
  PRIVATE_MEDIA_MAX_SIZE_BYTES,
  PRIVATE_MEDIA_MIME_TYPES,
  type PrivateMediaMetadata,
  type PrivateMediaMimeType,
} from '../domain/private-media';
import type {
  PrivateMediaAccess,
  PrivateMediaContext,
} from './private-media-access';
import type { PrismaPrivateMediaRepository } from '../infrastructure/prisma-private-media.repository';
import type { PrivateS3Storage } from '../infrastructure/private-s3-storage';
import type { PrivateMediaConfig } from '../infrastructure/private-media-config';

/** Internal new-file upload only; no HTTP activation or client-owned storage keys. */
export class PrivateMediaService {
  private readonly maxBytes: number;

  constructor(
    private readonly access: Pick<PrivateMediaAccess, 'canUpload'>,
    private readonly storage: Pick<PrivateS3Storage, 'put'>,
    private readonly repository: Pick<PrismaPrivateMediaRepository, 'create'>,
    config: Pick<PrivateMediaConfig, 'maxBytes'>,
  ) {
    const maxBytes = config?.maxBytes;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > PRIVATE_MEDIA_MAX_SIZE_BYTES
    )
      throw new Error('Invalid private media size limit');
    this.maxBytes = maxBytes;
  }

  async upload(
    context: PrivateMediaContext,
    input: { mimeType: string; bytes: Buffer },
  ): Promise<PrivateMediaMetadata | null> {
    try {
      const { actorId, tenantId, productId } = context;
      const { mimeType, bytes } = input;
      if (
        [actorId, tenantId, productId].some(
          (id) => typeof id !== 'string' || !id.trim(),
        ) ||
        !PRIVATE_MEDIA_MIME_TYPES.includes(mimeType as PrivateMediaMimeType) ||
        !Buffer.isBuffer(bytes) ||
        bytes.length <= 0 ||
        bytes.length > this.maxBytes
      )
        return null;
      const copiedBytes = Buffer.from(bytes);
      const sizeBytes = copiedBytes.length;
      if (!(await this.access.canUpload({ actorId, tenantId, productId })))
        return null;
      const asset = {
        id: randomUUID(),
        tenantId,
        productId,
        storageKey: `private-media/${randomUUID()}`,
        mimeType: mimeType as PrivateMediaMimeType,
        sizeBytes,
        createdAt: new Date(),
      };
      await this.storage.put(asset, copiedBytes);
      const persisted = await this.repository.create(asset);
      if (!persisted) return null;
      return {
        id: persisted.id,
        tenantId: persisted.tenantId,
        productId: persisted.productId,
        mimeType: persisted.mimeType,
        sizeBytes: persisted.sizeBytes,
        createdAt: persisted.createdAt,
      };
    } catch {
      // A failed/ambiguous create is not proof of rollback: never delete its bytes.
      return null;
    }
  }
}
