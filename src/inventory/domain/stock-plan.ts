import { allocateFefo } from './fefo-allocator';
import {
  InsufficientStockError,
  StockBucketNotFoundError,
  StockNotTrackedError,
  StockVersionConflictError,
} from './stock-journal.errors';
import type {
  LotStockState,
  PlannedMovement,
  ProductStockState,
  StockBucketRef,
  StockChange,
  StockChargeItem,
  VariantStockState,
} from './stock-journal.types';

/**
 * Pure planner for one journal write: applies signed bucket changes to an
 * in-memory copy of the (already locked) stock state, enforcing S4/S10, and
 * records the movement rows plus what must be persisted. Persistence and
 * locking live in the writer; nothing here touches I/O.
 */
export class StockPlan {
  readonly movements: PlannedMovement[] = [];
  /** Products whose `quantity` changed; `bumpVersion` when the untracked bucket changed. */
  readonly touchedProducts = new Map<
    string,
    { quantity: number; bumpVersion: boolean }
  >();
  readonly touchedLots = new Map<string, number>();
  readonly touchedVariants = new Map<string, number>();

  private readonly products = new Map<string, ProductStockState>();

  constructor(
    products: ProductStockState[],
    private readonly today: string,
  ) {
    for (const p of products) {
      this.products.set(p.id, {
        ...p,
        lots: p.lots.map((l) => ({ ...l })),
        variants: p.variants.map((v) => ({ ...v })),
      });
    }
  }

  /** Sale line: variant lines hit the variant, product lines go FEFO (S6). */
  charge(item: StockChargeItem): void {
    if (item.variantId) {
      this.apply({
        bucket: {
          kind: 'VARIANT',
          productId: item.productId,
          variantId: item.variantId,
        },
        delta: -item.quantity,
      });
      return;
    }
    const product = this.requireProduct(item.productId, 'PRODUCT_UNTRACKED');
    if (!product.useStock) return;
    const allocations = allocateFefo({
      quantity: item.quantity,
      untrackedAvailable: this.untracked(product),
      lots: product.lots,
      today: this.today,
    });
    for (const a of allocations) {
      this.apply({
        bucket: a.lotId
          ? { kind: 'LOT', productId: item.productId, lotId: a.lotId }
          : { kind: 'PRODUCT_UNTRACKED', productId: item.productId },
        delta: -a.quantity,
      });
    }
  }

  apply(change: StockChange): void {
    if (!Number.isInteger(change.delta) || change.delta === 0) {
      throw new RangeError('Stock delta must be a non-zero integer');
    }
    const { bucket } = change;
    switch (bucket.kind) {
      case 'PRODUCT_UNTRACKED':
        return this.applyUntracked(bucket.productId, change);
      case 'LOT':
        return this.applyLot(bucket.productId, bucket.lotId, change);
      case 'VARIANT':
        return this.applyVariant(bucket.productId, bucket.variantId, change);
    }
  }

  /** Whether the bucket exists in the loaded state (reversals skip vanished ones). */
  has(bucket: StockBucketRef): boolean {
    const product = this.products.get(bucket.productId);
    if (!product) return false;
    switch (bucket.kind) {
      case 'PRODUCT_UNTRACKED':
        return !product.hasVariants;
      case 'LOT':
        return product.lots.some((l) => l.id === bucket.lotId);
      case 'VARIANT':
        return product.variants.some((v) => v.id === bucket.variantId);
    }
  }

  /** Current in-plan quantity of a product (non-variant products only). */
  productQuantity(productId: string): number | undefined {
    return this.products.get(productId)?.quantity;
  }

  private applyUntracked(productId: string, change: StockChange): void {
    const product = this.requireProduct(productId, 'PRODUCT_UNTRACKED');
    if (product.hasVariants) {
      throw new StockBucketNotFoundError('PRODUCT_UNTRACKED', productId);
    }
    if (!product.useStock) {
      if (change.skipIfNotStocked) return;
      throw new StockNotTrackedError(productId);
    }
    this.checkVersion(
      'PRODUCT_UNTRACKED',
      productId,
      product.stockVersion,
      change,
    );
    const untracked = this.untracked(product);
    if (untracked + change.delta < 0) {
      throw new InsufficientStockError(
        'PRODUCT_UNTRACKED',
        productId,
        untracked,
        -change.delta,
      );
    }
    product.quantity += change.delta;
    this.touchedProducts.set(productId, {
      quantity: product.quantity,
      bumpVersion: true,
    });
    this.record(product, {
      bucketKind: 'PRODUCT_UNTRACKED',
      delta: change.delta,
      balanceAfter: untracked + change.delta,
      bucketVersionAfter: product.stockVersion + 1,
    });
  }

  private applyLot(
    productId: string,
    lotId: string,
    change: StockChange,
  ): void {
    const product = this.requireProduct(productId, 'LOT');
    const lot = product.lots.find((l) => l.id === lotId);
    if (!lot || product.hasVariants) {
      throw new StockBucketNotFoundError('LOT', lotId);
    }
    this.checkVersion('LOT', lotId, lot.stockVersion, change);
    if (lot.quantity + change.delta < 0) {
      throw new InsufficientStockError(
        'LOT',
        lotId,
        lot.quantity,
        -change.delta,
      );
    }
    if (product.quantity + change.delta < 0) {
      throw new InsufficientStockError(
        'PRODUCT',
        productId,
        product.quantity,
        -change.delta,
      );
    }
    lot.quantity += change.delta;
    product.quantity += change.delta;
    this.touchedLots.set(lotId, lot.quantity);
    const prior = this.touchedProducts.get(productId);
    this.touchedProducts.set(productId, {
      quantity: product.quantity,
      bumpVersion: prior?.bumpVersion ?? false,
    });
    this.record(product, {
      bucketKind: 'LOT',
      lot,
      delta: change.delta,
      balanceAfter: lot.quantity,
      bucketVersionAfter: lot.stockVersion + 1,
    });
  }

  private applyVariant(
    productId: string,
    variantId: string,
    change: StockChange,
  ): void {
    const product = this.requireProduct(productId, 'VARIANT');
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) throw new StockBucketNotFoundError('VARIANT', variantId);
    this.checkVersion('VARIANT', variantId, variant.stockVersion, change);
    if (variant.quantity + change.delta < 0) {
      throw new InsufficientStockError(
        'VARIANT',
        variantId,
        variant.quantity,
        -change.delta,
      );
    }
    variant.quantity += change.delta;
    this.touchedVariants.set(variantId, variant.quantity);
    this.record(product, {
      bucketKind: 'VARIANT',
      variant,
      delta: change.delta,
      balanceAfter: variant.quantity,
      bucketVersionAfter: variant.stockVersion + 1,
    });
  }

  private record(
    product: ProductStockState,
    row: {
      bucketKind: PlannedMovement['bucketKind'];
      lot?: LotStockState;
      variant?: VariantStockState;
      delta: number;
      balanceAfter: number;
      bucketVersionAfter: number;
    },
  ): void {
    this.movements.push({
      bucketKind: row.bucketKind,
      productId: product.id,
      variantId: row.variant?.id ?? null,
      lotId: row.lot?.id ?? null,
      productName: product.name,
      variantLabel: row.variant?.name ?? null,
      lotNumber: row.lot?.lotNumber ?? null,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      productBalanceAfter: product.hasVariants
        ? product.variants.reduce((sum, v) => sum + v.quantity, 0)
        : product.quantity,
      bucketVersionAfter: row.bucketVersionAfter,
    });
  }

  private untracked(product: ProductStockState): number {
    return product.quantity - product.lots.reduce((s, l) => s + l.quantity, 0);
  }

  private checkVersion(
    kind: string,
    id: string,
    current: number,
    change: StockChange,
  ): void {
    if (
      change.expectedVersion !== undefined &&
      change.expectedVersion !== current
    ) {
      throw new StockVersionConflictError(kind, id, current);
    }
  }

  private requireProduct(id: string, kind: string): ProductStockState {
    const product = this.products.get(id);
    if (!product) throw new StockBucketNotFoundError(kind, id);
    return product;
  }
}
