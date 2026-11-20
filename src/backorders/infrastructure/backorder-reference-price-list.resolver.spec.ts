/**
 * restock-backorder / T1b (low 4) — `referencePriceListId` is the customer's
 * list only when that list really priced the line; when the price came from the
 * PUBLICO fallback (the list has no price for the product/variant) it is null.
 */
import type { ProductsService } from '../../products/products.service';
import { BackorderReferencePriceListResolver } from './backorder-reference-price-list.resolver';

const LIST = 'list-mayoreo';
const line = { productId: 'prod-1', variantId: null, quantity: 3 };

function makeResolver(prices: Map<string, Map<number, number>>) {
  const batchResolvePriceMap = jest.fn<Promise<typeof prices>, [unknown]>(() =>
    Promise.resolve(prices),
  );
  const resolver = new BackorderReferencePriceListResolver({
    batchResolvePriceMap,
  } as unknown as ProductsService);
  return { resolver, batchResolvePriceMap };
}

describe('BackorderReferencePriceListResolver', () => {
  it("returns the customer's list id when that list prices the product", async () => {
    const { resolver, batchResolvePriceMap } = makeResolver(
      new Map([[`prod-1::::${LIST}`, new Map([[3, 9900]])]]),
    );

    await expect(resolver.resolve(LIST, line)).resolves.toBe(LIST);
    expect(batchResolvePriceMap).toHaveBeenCalledWith([
      {
        productId: 'prod-1',
        variantId: null,
        quantity: 3,
        priceListId: LIST,
        globalPriceListId: LIST,
      },
    ]);
  });

  it('returns null when the customer list has no price (PUBLICO fallback)', async () => {
    const { resolver } = makeResolver(new Map());
    await expect(resolver.resolve(LIST, line)).resolves.toBeNull();
  });

  it('keys variant lines by variant id', async () => {
    const variantLine = { ...line, variantId: 'var-1' };
    const priced = makeResolver(
      new Map([[`prod-1::var-1::${LIST}`, new Map([[3, 9900]])]]),
    );
    await expect(priced.resolver.resolve(LIST, variantLine)).resolves.toBe(
      LIST,
    );
    const fallback = makeResolver(
      new Map([[`prod-1::other::${LIST}`, new Map([[3, 9900]])]]),
    );
    await expect(
      fallback.resolver.resolve(LIST, variantLine),
    ).resolves.toBeNull();
  });

  it('returns null without a lookup when the customer has no list (priced as PUBLICO)', async () => {
    const { resolver, batchResolvePriceMap } = makeResolver(new Map());
    await expect(resolver.resolve(null, line)).resolves.toBeNull();
    expect(batchResolvePriceMap).not.toHaveBeenCalled();
  });
});
