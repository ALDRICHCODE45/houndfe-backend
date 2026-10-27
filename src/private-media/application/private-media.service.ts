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

/** Internal private media only; no HTTP activation or client-owned storage keys. */
export class PrivateMediaService {
  private readonly maxBytes: number;

  constructor(
    private readonly access: Pick<PrivateMediaAccess, 'canUpload' | 'canRead'>,
    private readonly storage: Pick<PrivateS3Storage, 'put' | 'read'>,
    private readonly repository: Pick<
      PrismaPrivateMediaRepository,
      'create' | 'find'
    >,
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

  async read(
    context: PrivateMediaContext,
    assetId: string,
  ): Promise<Buffer | null> {
    try {
      const { actorId, tenantId, productId } = context;
      if (
        [actorId, tenantId, productId, assetId].some(
          (id) => typeof id !== 'string' || !id.trim(),
        )
      )
        return null;
      const asset = await this.repository.find({
        id: assetId,
        tenantId,
        productId,
      });
      if (
        !asset ||
        asset.id !== assetId ||
        asset.tenantId !== tenantId ||
        asset.productId !== productId ||
        asset.sizeBytes > this.maxBytes
      )
        return null;
      const { storageKey, mimeType, sizeBytes } = asset;
      if (
        !(await this.access.canRead({
          actorId,
          tenantId: asset.tenantId,
          productId: asset.productId,
        }))
      )
        return null;
      return await this.storage.read({ storageKey, mimeType, sizeBytes });
    } catch {
      return null;
    }
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
