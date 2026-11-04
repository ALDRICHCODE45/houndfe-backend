import type { StockMovement } from '@prisma/client';
import { isLotExpired } from '../domain/fefo-allocator';
import type { MovementView, StockSnapshot } from './inventory-contract';

export interface StockRows {
  product: {
    id: string;
    name: string;
    type: string;
    useStock: boolean;
    hasVariants: boolean;
    quantity: number;
    stockVersion: number;
  };
  lots: {
    id: string;
    lotNumber: string;
    quantity: number;
    stockVersion: number;
    expirationDate: Date;
  }[];
  variants: {
    id: string;
    name: string;
    quantity: number;
    stockVersion: number;
  }[];
}

/**
 * Pure projection of locked/read rows into the stock contract. `today` is the
 * business calendar date (`YYYY-MM-DD`); expired lots are never sellable.
 */
export function buildStockSnapshot(
  rows: StockRows,
  today: string,
): StockSnapshot {
  const { product } = rows;
  const lots = [...rows.lots]
    .sort(
      (a, b) =>
        a.expirationDate.getTime() - b.expirationDate.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((lot) => ({
      id: lot.id,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate.toISOString().slice(0, 10),
      quantity: lot.quantity,
      expired: isLotExpired(lot.expirationDate, today),
      version: lot.stockVersion,
    }));
  const variants = rows.variants.map((variant) => ({
    id: variant.id,
    label: variant.name,
    quantity: variant.quantity,
    version: variant.stockVersion,
  }));
  const tracked = product.useStock && product.type !== 'SERVICE';
  let quantity = product.quantity;
  let untracked = product.quantity - lots.reduce((s, l) => s + l.quantity, 0);
  let sellable =
    quantity - lots.reduce((s, l) => s + (l.expired ? l.quantity : 0), 0);
  if (product.hasVariants) {
    quantity = variants.reduce((s, v) => s + v.quantity, 0);
    untracked = 0;
    sellable = quantity;
  }
  return {
    product: {
      id: product.id,
      name: product.name,
      useStock: product.useStock,
      quantity,
      untracked: { quantity: untracked, version: product.stockVersion },
      sellable: tracked ? sellable : null,
    },
    lots,
    variants,
  };
}

export function toMovementView(row: StockMovement): MovementView {
  return {
    id: row.id,
    type: row.type,
    bucket: row.bucketKind,
    productId: row.productId,
    variantId: row.variantId,
    lotId: row.lotId,
    labels: {
      product: row.productName,
      variant: row.variantLabel,
      lot: row.lotNumber,
    },
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    productBalanceAfter: row.productBalanceAfter,
    reason: row.reason,
    note: row.note,
    removalCause: row.removalCause,
    group: { type: row.groupType, id: row.groupId },
    actor: { displayName: row.actorDisplayName },
    createdAt: row.createdAt.toISOString(),
  };
}
