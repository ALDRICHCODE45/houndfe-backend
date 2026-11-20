import { foldHeldBuckets, mapBackorderRelease } from './backorder-reservation';
import type {
  BackorderMovementRecord,
  HeldBackorderBucket,
} from './stock-journal.types';

const lot = (lotId: string, delta: number): BackorderMovementRecord => ({
  bucketKind: 'LOT',
  productId: 'p1',
  variantId: null,
  lotId,
  delta,
});
const untracked = (delta: number): BackorderMovementRecord => ({
  bucketKind: 'PRODUCT_UNTRACKED',
  productId: 'p1',
  variantId: null,
  lotId: null,
  delta,
});
const variant = (
  variantId: string,
  delta: number,
): BackorderMovementRecord => ({
  bucketKind: 'VARIANT',
  productId: 'p2',
  variantId,
  lotId: null,
  delta,
});

describe('foldHeldBuckets (BACKORDER_RESERVE minus BACKORDER_RELEASE)', () => {
  it('holds what each reserve row took, per bucket', () => {
    expect(
      foldHeldBuckets([lot('a', -5), untracked(-2), variant('v1', -3)]),
    ).toEqual([
      {
        bucketKind: 'LOT',
        productId: 'p1',
        variantId: null,
        lotId: 'a',
        held: 5,
      },
      {
        bucketKind: 'PRODUCT_UNTRACKED',
        productId: 'p1',
        variantId: null,
        lotId: null,
        held: 2,
      },
      {
        bucketKind: 'VARIANT',
        productId: 'p2',
        variantId: 'v1',
        lotId: null,
        held: 3,
      },
    ]);
  });

  it('nets release rows against the same bucket and drops buckets that reached zero', () => {
    const held = foldHeldBuckets([
      lot('a', -5),
      lot('b', -4),
      untracked(-2),
      lot('a', 5), // lot swap released lot a completely
      lot('b', 1), // partial release of lot b
    ]);
    expect(held.map((h) => [h.lotId, h.held])).toEqual([
      ['b', 3],
      [null, 2],
    ]);
  });

  it('holds nothing for an empty or fully released group', () => {
    expect(foldHeldBuckets([])).toEqual([]);
    expect(foldHeldBuckets([lot('a', -5), lot('a', 5)])).toEqual([]);
  });

  it('never reports a negative hold (defensive: release rows without a reserve)', () => {
    expect(foldHeldBuckets([lot('a', 4)])).toEqual([]);
  });
});

describe('mapBackorderRelease (returns units to the same buckets)', () => {
  const held: HeldBackorderBucket[] = [
    {
      bucketKind: 'LOT',
      productId: 'p1',
      variantId: null,
      lotId: 'a',
      held: 5,
    },
    {
      bucketKind: 'LOT',
      productId: 'p1',
      variantId: null,
      lotId: 'gone',
      held: 1,
    },
    {
      bucketKind: 'PRODUCT_UNTRACKED',
      productId: 'p1',
      variantId: null,
      lotId: null,
      held: 2,
    },
    {
      bucketKind: 'VARIANT',
      productId: 'p2',
      variantId: 'v1',
      lotId: null,
      held: 3,
    },
  ];

  it('restores lots, untracked and variants with the held quantity; a deleted lot falls back to untracked', () => {
    expect(mapBackorderRelease(held, new Set(['a']))).toEqual([
      { bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' }, delta: 5 },
      { bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' }, delta: 1 },
      { bucket: { kind: 'PRODUCT_UNTRACKED', productId: 'p1' }, delta: 2 },
      {
        bucket: { kind: 'VARIANT', productId: 'p2', variantId: 'v1' },
        delta: 3,
      },
    ]);
  });

  it('with onlyLotIds releases just those lots (lot swap) and nothing else', () => {
    expect(mapBackorderRelease(held, new Set(['a']), ['a'])).toEqual([
      { bucket: { kind: 'LOT', productId: 'p1', lotId: 'a' }, delta: 5 },
    ]);
    expect(mapBackorderRelease(held, new Set(['a']), [])).toEqual([]);
  });
});
