import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

/**
 * restock-backorder / T5b — units a RESERVED backorder holds (contract v1 §3).
 *
 * Reserved units are journaled OUT of `quantity` (`BACKORDER_RESERVE`), so
 * `quantity` is what the counter can sell (`availableToSell`) and
 * `stockOnHand = quantity + reservedForBackorders`. The reserved figure is read
 * from the backorders themselves (Σ RESERVED `quantity`, indexed by
 * `(tenantId, productId, variantId, status)`), tenant-scoped, in ONE grouped
 * query for any number of products — callers batch their whole response.
 */
export interface ReservedStockIndex {
  /** Reserved units of the whole product: product level plus every variant. */
  forProduct(productId: string): number;
  /** Reserved units of one line: `variantId` null is the product-level line. */
  forLine(productId: string, variantId: string | null): number;
}

const EMPTY_INDEX: ReservedStockIndex = {
  forProduct: () => 0,
  forLine: () => 0,
};

const lineKey = (productId: string, variantId: string | null) =>
  `${productId}:${variantId ?? ''}`;

export async function loadReservedStock(
  tenantPrisma: TenantPrismaService,
  productIds: readonly string[],
): Promise<ReservedStockIndex> {
  const distinct = [...new Set(productIds)];
  if (distinct.length === 0) return EMPTY_INDEX;

  const rows = await tenantPrisma.getClient().backorder.groupBy({
    by: ['productId', 'variantId'],
    where: {
      tenantId: tenantPrisma.getTenantId(),
      status: 'RESERVED',
      productId: { in: distinct },
    },
    _sum: { quantity: true },
  });

  const byLine = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const row of rows) {
    const quantity = row._sum.quantity ?? 0;
    byLine.set(lineKey(row.productId, row.variantId), quantity);
    byProduct.set(
      row.productId,
      (byProduct.get(row.productId) ?? 0) + quantity,
    );
  }
  return {
    forProduct: (productId) => byProduct.get(productId) ?? 0,
    forLine: (productId, variantId) =>
      byLine.get(lineKey(productId, variantId)) ?? 0,
  };
}

/**
 * The three additive stock fields of the POS reads. `availableToSell` is the
 * sellable quantity (today's `quantity`), `reservedForBackorders` the units
 * held for backorders, `stockOnHand` both together.
 */
export function backorderStockFields(
  availableToSell: number,
  reservedForBackorders: number,
) {
  return {
    stockOnHand: availableToSell + reservedForBackorders,
    reservedForBackorders,
    availableToSell,
  };
}
