import { Prisma } from '@prisma/client';
import type { DocumentAuthority } from '../domain/document';

/**
 * Precondition: caller already holds the tenant/product-qualified Product gate
 * in this SAME transaction and retains it through validation and commit.
 * This read grants no authorization; it neither acquires the gate nor locks
 * child Variant rows. Coordinated membership writers must use that gate too.
 */
export async function readLockedEditorialReferences(
  tx: Prisma.TransactionClient,
  scope: Pick<DocumentAuthority, 'tenantId' | 'productId'>,
  selectedAssetIds: readonly string[],
): Promise<Omit<DocumentAuthority, 'families'>> {
  // Capture caller-owned qualification and the union of document selections
  // before the first await. Invalid internal inputs are not a public API policy.
  const { tenantId, productId } = scope;
  if (
    [tenantId, productId].some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    ) ||
    !Array.isArray(selectedAssetIds)
  )
    throw new TypeError('Invalid editorial reference inputs');
  const selected = Array.from(selectedAssetIds);
  if (selected.some((id) => typeof id !== 'string'))
    throw new TypeError('Invalid editorial asset selection');
  const assetIds = [...new Set(selected)].sort();

  const variants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM variants
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
    ORDER BY id`);
  const membership = assetIds.length
    ? Prisma.sql`id IN (${Prisma.join(assetIds)})`
    : Prisma.sql`FALSE`;
  // Even an empty selection observes the real qualified source. Source errors
  // propagate; absent positive IDs remain absent for strict document validation.
  const assets = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM private_media_assets
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
      AND ${membership}
    ORDER BY id FOR SHARE`);
  return {
    tenantId,
    productId,
    variantIds: variants.map(({ id }) => id),
    assetIds: assets.map(({ id }) => id),
  };
}
