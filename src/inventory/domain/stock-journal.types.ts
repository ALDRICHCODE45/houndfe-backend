/**
 * Inventory journal core types (O1).
 *
 * Domain-level string unions mirror the Prisma enums so the planning code stays
 * free of Prisma imports. A "bucket" is the smallest unit whose quantity is
 * journaled: the untracked portion of a non-variant product
 * (`Product.quantity - sum(Lot.quantity)`), a variant, or a lot.
 */

export type StockBucketKind = 'PRODUCT_UNTRACKED' | 'VARIANT' | 'LOT';

export type StockMovementType =
  | 'OPENING'
  | 'INITIAL'
  | 'ADJUSTMENT'
  | 'SALE'
  | 'SALE_CANCELLATION'
  | 'REMOVAL';

export type StockAdjustmentReason =
  | 'PHYSICAL_COUNT'
  | 'DAMAGE'
  | 'EXPIRED'
  | 'THEFT_LOSS'
  | 'DATA_ENTRY_CORRECTION'
  | 'OTHER';

export type StockRemovalCause =
  | 'VARIANT_DELETED'
  | 'PRODUCT_DELETED'
  | 'PRODUCT_CONVERTED_TO_SERVICE'
  | 'FIRST_VARIANT_ZEROING';

export type StockMovementGroupType = 'SALE' | 'ADJUSTMENT' | 'PRODUCT';

export type StockBucketRef =
  | { kind: 'PRODUCT_UNTRACKED'; productId: string }
  | { kind: 'VARIANT'; productId: string; variantId: string }
  | { kind: 'LOT'; productId: string; lotId: string };

/** One signed quantity change against one bucket. */
export interface StockChange {
  bucket: StockBucketRef;
  /** Signed, non-zero. */
  delta: number;
  /** Bucket `stockVersion` the caller last saw; mismatch => STOCK_VERSION_CONFLICT. */
  expectedVersion?: number;
  /** Untracked change on a `useStock=false` product is dropped instead of rejected. */
  skipIfNotStocked?: boolean;
}

export interface StockActor {
  id: string | null;
  displayName: string;
}

/** Attributes shared by every movement row written by one call. */
export interface StockJournalContext {
  type: StockMovementType;
  groupType: StockMovementGroupType;
  groupId: string;
  actor: StockActor;
  reason?: StockAdjustmentReason | null;
  note?: string | null;
  removalCause?: StockRemovalCause | null;
}

/** A sale line to charge; variant lines hit the variant, others go FEFO. */
export interface StockChargeItem {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface LotStockState {
  id: string;
  lotNumber: string;
  quantity: number;
  stockVersion: number;
  expirationDate: Date;
}

export interface VariantStockState {
  id: string;
  name: string;
  quantity: number;
  stockVersion: number;
}

export interface ProductStockState {
  id: string;
  name: string;
  quantity: number;
  stockVersion: number;
  useStock: boolean;
  hasVariants: boolean;
  lots: LotStockState[];
  variants: VariantStockState[];
}

/** A movement row as planned (before id/createdAt/actor are attached). */
export interface PlannedMovement {
  bucketKind: StockBucketKind;
  productId: string;
  variantId: string | null;
  lotId: string | null;
  productName: string;
  variantLabel: string | null;
  lotNumber: string | null;
  delta: number;
  balanceAfter: number;
  productBalanceAfter: number;
  /** `stockVersion` of the bucket after this call. */
  bucketVersionAfter: number;
}

/** Row handed back to callers after persistence. */
export interface AppliedStockMovement extends PlannedMovement {
  id: string;
  type: StockMovementType;
  groupType: StockMovementGroupType;
  groupId: string;
  createdAt: Date;
}

/** `SALE` movement fields the reversal mapping needs. */
export interface SaleMovementRecord {
  bucketKind: StockBucketKind;
  productId: string;
  variantId: string | null;
  lotId: string | null;
  delta: number;
}

export type SaleReversalOutcome =
  | { status: 'REVERSED'; movements: AppliedStockMovement[]; skipped: number }
  /**
   * No `SALE` movements and the sale was confirmed after the journal went live
   * (or no lines were supplied): it consumed nothing journaled, so nothing is
   * restored.
   */
  | { status: 'NOTHING_TO_RESTORE'; movements: [] }
  /** SALE_CANCELLATION rows already exist for this sale; nothing written. */
  | { status: 'ALREADY_REVERSED'; movements: [] };
