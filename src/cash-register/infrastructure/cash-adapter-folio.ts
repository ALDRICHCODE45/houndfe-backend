/**
 * pdf-a4-redesign T6 (S4) — per-tenant consecutive cash-closing folio.
 *
 * New closings get `CC-000124`: a tenant-scoped counter incremented
 * atomically inside the closing transaction. Closings stored before the
 * counter existed keep their UUID-shaped folio (`CC-<uuid>`); the two shapes
 * can never collide.
 *
 * Concurrency: `upsert` on the unique `tenantId` is a single atomic
 * `INSERT ... ON CONFLICT ("tenantId") DO UPDATE SET "lastNumber" =
 * "lastNumber" + 1 RETURNING`. A concurrent closing in the same tenant waits
 * on that row lock until this transaction commits (or rolls back, releasing
 * the number), so two closings can never read the same value. This mirrors
 * the sales folio counter (`PrismaSaleRepository.allocateNextFolio`), per
 * tenant and without a period.
 */
import type { TenantClient } from './cash-adapter-client';

/** `CC-` plus the number zero padded to 6 digits; wider numbers are not truncated. */
export function formatClosingFolio(sequence: number): string {
  return `CC-${String(sequence).padStart(6, '0')}`;
}

/** Allocate the next folio of `tenantId`; must run inside the closing transaction. */
export async function allocateClosingFolio(
  tx: TenantClient,
  tenantId: string,
): Promise<string> {
  const counter = await tx.cashClosingFolioCounter.upsert({
    where: { tenantId },
    create: { tenantId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return formatClosingFolio(counter.lastNumber);
}
