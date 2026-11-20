/**
 * Per-tenant consecutive backorder folio (`BO-000124`): a tenant-scoped counter
 * incremented atomically inside the creating transaction. Mirrors
 * `cash-register/infrastructure/cash-adapter-folio.ts` (`CC-000124`).
 *
 * Concurrency: `upsert` on the unique `tenantId` is a single atomic
 * `INSERT ... ON CONFLICT ("tenantId") DO UPDATE SET "lastNumber" =
 * "lastNumber" + 1 RETURNING`. A concurrent creation in the same tenant waits
 * on that row lock until this transaction commits (or rolls back, releasing the
 * number), so two backorders can never read the same value.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { formatBackorderFolio } from '../domain/backorder-folio';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** Allocate the next folio of `tenantId`; must run inside the creating transaction. */
export async function allocateBackorderFolio(
  tx: TenantClient,
  tenantId: string,
): Promise<string> {
  const counter = await tx.backorderFolioCounter.upsert({
    where: { tenantId },
    create: { tenantId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return formatBackorderFolio(counter.lastNumber);
}
