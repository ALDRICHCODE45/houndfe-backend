import type {
  BackorderMovementRecord,
  HeldBackorderBucket,
  StockChange,
} from './stock-journal.types';

const bucketKey = (m: BackorderMovementRecord): string =>
  `${m.bucketKind}:${m.productId}:${m.variantId ?? ''}:${m.lotId ?? ''}`;

/**
 * Units a backorder still holds per bucket: the sum of its `BACKORDER_RESERVE`
 * (negative) and `BACKORDER_RELEASE` (positive) deltas, inverted. Buckets whose
 * net hold is not positive are dropped. Order of first appearance is kept so
 * the release writes its rows in the order the reservation took them.
 */
export function foldHeldBuckets(
  movements: readonly BackorderMovementRecord[],
): HeldBackorderBucket[] {
  const byBucket = new Map<string, HeldBackorderBucket>();
  for (const m of movements) {
    const key = bucketKey(m);
    const current = byBucket.get(key);
    if (current) {
      current.held -= m.delta;
    } else {
      byBucket.set(key, {
        bucketKind: m.bucketKind,
        productId: m.productId,
        variantId: m.variantId,
        lotId: m.lotId,
        held: -m.delta,
      });
    }
  }
  return [...byBucket.values()].filter((bucket) => bucket.held > 0);
}

/**
 * Changes that hand held units back to the SAME buckets they came from (like
 * `mapSaleReversal`): variant → variant, lot → lot, untracked → untracked. A
 * lot deleted since the reservation (absent from `existingLotIds`) returns to
 * the product's untracked portion. `onlyLotIds` restricts the release to those
 * lots (lot swap): every non-lot bucket is then left held.
 */
export function mapBackorderRelease(
  held: readonly HeldBackorderBucket[],
  existingLotIds: ReadonlySet<string>,
  onlyLotIds?: readonly string[],
): StockChange[] {
  const changes: StockChange[] = [];
  for (const bucket of held) {
    if (bucket.held <= 0) continue;
    if (
      onlyLotIds &&
      !(bucket.bucketKind === 'LOT' && onlyLotIds.includes(bucket.lotId ?? ''))
    ) {
      continue;
    }
    if (bucket.bucketKind === 'VARIANT' && bucket.variantId) {
      changes.push({
        bucket: {
          kind: 'VARIANT',
          productId: bucket.productId,
          variantId: bucket.variantId,
        },
        delta: bucket.held,
      });
    } else if (
      bucket.bucketKind === 'LOT' &&
      bucket.lotId &&
      existingLotIds.has(bucket.lotId)
    ) {
      changes.push({
        bucket: {
          kind: 'LOT',
          productId: bucket.productId,
          lotId: bucket.lotId,
        },
        delta: bucket.held,
      });
    } else {
      changes.push({
        bucket: { kind: 'PRODUCT_UNTRACKED', productId: bucket.productId },
        delta: bucket.held,
      });
    }
  }
  return changes;
}
