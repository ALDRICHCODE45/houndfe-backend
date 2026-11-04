import type { SaleMovementRecord, StockChange } from './stock-journal.types';

/**
 * Maps the `SALE` movements of a sale to the changes that restore them (S7):
 * same bucket, inverted sign. A lot deleted since the sale (absent from
 * `existingLotIds`) is restored to the product's untracked portion.
 */
export function mapSaleReversal(
  saleMovements: SaleMovementRecord[],
  existingLotIds: ReadonlySet<string>,
): StockChange[] {
  const changes: StockChange[] = [];
  for (const m of saleMovements) {
    if (m.delta >= 0) continue;
    const delta = -m.delta;
    if (m.bucketKind === 'VARIANT' && m.variantId) {
      changes.push({
        bucket: {
          kind: 'VARIANT',
          productId: m.productId,
          variantId: m.variantId,
        },
        delta,
      });
    } else if (
      m.bucketKind === 'LOT' &&
      m.lotId &&
      existingLotIds.has(m.lotId)
    ) {
      changes.push({
        bucket: { kind: 'LOT', productId: m.productId, lotId: m.lotId },
        delta,
      });
    } else {
      changes.push({
        bucket: { kind: 'PRODUCT_UNTRACKED', productId: m.productId },
        delta,
      });
    }
  }
  return changes;
}
