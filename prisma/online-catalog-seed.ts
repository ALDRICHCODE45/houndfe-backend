/**
 * F1.WU1b — Production PUBLICO catalog-default binding helper.
 * Binds PUBLICO (isDefault=true) as each tenant's catalog default, but ONLY
 * for tenants with zero existing TenantCatalogPriceList rows. Admin-configured
 * bindings are never overwritten. Called from prisma/seed.ts after PUBLICO is
 * upserted (inside the same transaction) and exercised directly by unit /
 * integration specs as the authoritative production helper.
 */
import type { Prisma } from '@prisma/client';

export async function seedOnlineCatalogDefaults(
  tx: Prisma.TransactionClient,
  tenantIds: string[],
  pubblicoId: string,
): Promise<void> {
  for (const tenantId of tenantIds) {
    const bindingCount = await tx.tenantCatalogPriceList.count({ where: { tenantId } });
    if (bindingCount === 0) {
      await tx.tenantCatalogPriceList.create({
        data: { tenantId, globalPriceListId: pubblicoId, isCatalogDefault: true },
      });
    }
  }
}