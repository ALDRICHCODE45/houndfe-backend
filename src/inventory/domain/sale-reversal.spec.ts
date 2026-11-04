import { mapSaleReversal } from './sale-reversal';
import type { SaleMovementRecord } from './stock-journal.types';

const lotRow = (
  lotId: string,
  delta: number,
  productId = 'p1',
): SaleMovementRecord => ({
  bucketKind: 'LOT',
  productId,
  variantId: null,
  lotId,
  delta,
});

describe('mapSaleReversal (S7)', () => {
  it('restores exactly the buckets the SALE rows consumed, with inverted sign', () => {
    const changes = mapSaleReversal(
      [
        lotRow('a', -5),
        {
          bucketKind: 'PRODUCT_UNTRACKED',
          productId: 'p1',
          variantId: null,
          lotId: null,
          delta: -2,
        },
        {
          bucketKind: 'VARIANT',
          productId: 'p2',
          variantId: 'v1',
          lotId: null,
          delta: -3,
        },
      ],
      new Set(['a']),
    );
    expect(changes).toEqual([
      { bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' }, delta: 5 },
      { bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' }, delta: 2 },
      {
        bucket: { kind: 'VARIANT', productId: 'p2', variantId: 'v1' },
        delta: 3,
      },
    ]);
  });

  it('sends stock of a lot deleted since the sale to the untracked portion', () => {
    const changes = mapSaleReversal([lotRow('gone', -4)], new Set());
    expect(changes).toEqual([
      { bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' }, delta: 4 },
    ]);
  });

  it('ignores rows that did not consume stock', () => {
    expect(
      mapSaleReversal([lotRow('a', 0), lotRow('a', 2)], new Set(['a'])),
    ).toEqual([]);
  });
});
