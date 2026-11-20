/**
 * restock-backorder / T5b — the one batched read behind the stock fields
 * (contract v1 §3, §9.4): Σ RESERVED backorder quantities per product/variant,
 * tenant-scoped, ONE query for any number of products.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  backorderStockFields,
  loadReservedStock,
} from './backorder-reserved-stock';

function makeTenantPrisma(
  rows: Array<{
    productId: string;
    variantId: string | null;
    _sum: { quantity: number | null };
  }>,
) {
  const groupBy = jest.fn().mockResolvedValue(rows);
  const tenantPrisma = {
    getTenantId: () => 'tenant-1',
    getClient: () => ({ backorder: { groupBy } }),
  };
  return {
    groupBy,
    tenantPrisma: tenantPrisma as unknown as TenantPrismaService,
  };
}

describe('loadReservedStock', () => {
  it('runs no query when there are no products', async () => {
    const { tenantPrisma, groupBy } = makeTenantPrisma([]);

    const index = await loadReservedStock(tenantPrisma, []);

    expect(groupBy).not.toHaveBeenCalled();
    expect(index.forProduct('p1')).toBe(0);
    expect(index.forLine('p1', null)).toBe(0);
  });

  it('reads every product in ONE tenant-scoped groupBy over RESERVED backorders', async () => {
    const { tenantPrisma, groupBy } = makeTenantPrisma([]);

    await loadReservedStock(tenantPrisma, ['p1', 'p2', 'p1', 'p3']);

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['productId', 'variantId'],
      where: {
        tenantId: 'tenant-1',
        status: 'RESERVED',
        productId: { in: ['p1', 'p2', 'p3'] },
      },
      _sum: { quantity: true },
    });
  });

  it('indexes product level (variantId null), each variant and the product total', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { productId: 'p1', variantId: null, _sum: { quantity: 4 } },
      { productId: 'p2', variantId: 'v1', _sum: { quantity: 2 } },
      { productId: 'p2', variantId: 'v2', _sum: { quantity: 3 } },
      { productId: 'p3', variantId: null, _sum: { quantity: null } },
    ]);

    const index = await loadReservedStock(tenantPrisma, ['p1', 'p2', 'p3']);

    expect(index.forLine('p1', null)).toBe(4);
    expect(index.forProduct('p1')).toBe(4);
    expect(index.forLine('p2', 'v1')).toBe(2);
    expect(index.forLine('p2', 'v2')).toBe(3);
    expect(index.forLine('p2', null)).toBe(0);
    expect(index.forProduct('p2')).toBe(5);
    expect(index.forProduct('p3')).toBe(0);
    expect(index.forLine('p9', 'vx')).toBe(0);
  });
});

describe('backorderStockFields', () => {
  it('keeps availableToSell as the sellable quantity and adds the reserved units back for stockOnHand', () => {
    expect(backorderStockFields(7, 3)).toEqual({
      stockOnHand: 10,
      reservedForBackorders: 3,
      availableToSell: 7,
    });
    expect(backorderStockFields(0, 0)).toEqual({
      stockOnHand: 0,
      reservedForBackorders: 0,
      availableToSell: 0,
    });
  });
});
