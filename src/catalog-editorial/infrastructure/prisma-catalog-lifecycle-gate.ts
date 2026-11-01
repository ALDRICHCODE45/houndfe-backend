import type { Prisma } from '@prisma/client';

/**
 * Acquire first, before Tenant/Product/child locks, on the caller's transaction.
 * Relation identity avoids advisory-key collisions. Never upgrade shared to
 * exclusive: choose the strongest required mode before the first observation.
 */
export async function lockCatalogLifecycle(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  if (mode === 'shared') {
    await tx.$executeRaw`LOCK TABLE "global_price_lists" IN SHARE MODE`;
  } else {
    await tx.$executeRaw`LOCK TABLE "global_price_lists" IN SHARE ROW EXCLUSIVE MODE`;
  }
}
