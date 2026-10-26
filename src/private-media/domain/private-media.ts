export const PRIVATE_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const PRIVATE_MEDIA_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export type PrivateMediaMimeType = (typeof PRIVATE_MEDIA_MIME_TYPES)[number];

/** Internal persisted linkage; never serialize the storage key to callers. */
export interface PrivateMediaAsset {
  id: string;
  tenantId: string;
  productId: string;
  storageKey: string;
  mimeType: PrivateMediaMimeType;
  sizeBytes: number;
  createdAt: Date;
}

/** Caller-facing metadata, without storage location or public URL. */
export type PrivateMediaMetadata = Omit<PrivateMediaAsset, 'storageKey'>;
