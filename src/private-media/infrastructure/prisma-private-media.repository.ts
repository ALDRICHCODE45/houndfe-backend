import type { PrismaClient } from '@prisma/client';
import {
  PRIVATE_MEDIA_MAX_SIZE_BYTES,
  PRIVATE_MEDIA_MIME_TYPES,
  type PrivateMediaAsset,
} from '../domain/private-media';

export type PrivateMediaScope = Pick<
  PrivateMediaAsset,
  'id' | 'tenantId' | 'productId'
>;
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
function validScope(value: unknown): value is PrivateMediaScope {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return [row.id, row.tenantId, row.productId].every(nonempty);
}
function decode(value: unknown): PrivateMediaAsset | null {
  if (!validScope(value)) return null;
  const row = value as PrivateMediaAsset;
  if (
    !nonempty(row.storageKey) ||
    !PRIVATE_MEDIA_MIME_TYPES.includes(row.mimeType) ||
    !Number.isInteger(row.sizeBytes) ||
    row.sizeBytes <= 0 ||
    row.sizeBytes > PRIVATE_MEDIA_MAX_SIZE_BYTES ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: new Date(row.createdAt),
  };
}
function result(rows: unknown, scope: PrivateMediaScope) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = decode(rows[0]);
  return row &&
    row.id === scope.id &&
    row.tenantId === scope.tenantId &&
    row.productId === scope.productId
    ? row
    : null;
}

export class PrismaPrivateMediaRepository {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  /** Null after a query is indeterminate, NOT proof that no commit occurred. */
  async create(
    input: Readonly<PrivateMediaAsset>,
  ): Promise<PrivateMediaAsset | null> {
    try {
      const asset = decode(input);
      if (!asset) return null;
      const rows: unknown = await this.prisma.$queryRaw`
        INSERT INTO private_media_assets
          (id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt")
        VALUES (${asset.id}, ${asset.tenantId}, ${asset.productId}, ${asset.storageKey},
          ${asset.mimeType}, ${asset.sizeBytes}, ${asset.createdAt})
        RETURNING id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt"`;
      const row = result(rows, asset);
      return row &&
        row.storageKey === asset.storageKey &&
        row.mimeType === asset.mimeType &&
        row.sizeBytes === asset.sizeBytes &&
        row.createdAt.getTime() === asset.createdAt.getTime()
        ? row
        : null;
    } catch {
      return null;
    }
  }

  async find(
    input: Readonly<PrivateMediaScope>,
  ): Promise<PrivateMediaAsset | null> {
    try {
      if (!validScope(input)) return null;
      const scope = {
        id: input.id,
        tenantId: input.tenantId,
        productId: input.productId,
      };
      const rows: unknown = await this.prisma.$queryRaw`
        SELECT id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt"
        FROM private_media_assets
        WHERE id = ${scope.id} AND "tenantId" = ${scope.tenantId}
          AND "productId" = ${scope.productId}`;
      return result(rows, scope);
    } catch {
      return null;
    }
  }
}
