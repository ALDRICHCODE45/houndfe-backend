/**
 * ADAPTER UNIT SPEC: ManualRouteOptimizer — delivery-routes / WU3 (3.13).
 *
 * Mirrors the WU2 precedent — the identity echo is trivial but the
 * spec pins the contract so a future map-provider adapter knows the
 * baseline to satisfy.
 */
import { ManualRouteOptimizer } from './manual-route-optimizer';

describe('ManualRouteOptimizer (delivery-routes / WU3)', () => {
  const optimizer = new ManualRouteOptimizer();

  it('Given a list of saleIds, when optimize is called, then the result is an identity echo of the input order', async () => {
    const result = await optimizer.optimize({
      tenantId: 'tenant-1',
      saleIds: ['sale-3', 'sale-1', 'sale-2'],
    });
    expect(result.orderedSaleIds).toEqual(['sale-3', 'sale-1', 'sale-2']);
  });

  it('Given an empty list, when optimize is called, then the result is an empty array', async () => {
    const result = await optimizer.optimize({
      tenantId: 'tenant-1',
      saleIds: [],
    });
    expect(result.orderedSaleIds).toEqual([]);
  });

  it('Given an input list, when optimize is called, then the result is a defensive copy (mutating the input does not affect the result)', async () => {
    const input = {
      tenantId: 'tenant-1',
      saleIds: ['a', 'b'],
    };
    const result = await optimizer.optimize(input);
    input.saleIds.push('c');
    expect(result.orderedSaleIds).toEqual(['a', 'b']);
  });

  it('Given a non-array saleIds, when optimize is called, then it throws', async () => {
    await expect(
      optimizer.optimize({ tenantId: 'tenant-1', saleIds: null as never }),
    ).rejects.toThrow(/saleIds/);
  });
});
