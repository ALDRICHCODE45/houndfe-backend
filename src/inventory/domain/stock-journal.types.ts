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
  | 'REMOVAL'
  | 'BACKORDER_RESERVE'
  | 'BACKORDER_RELEASE';

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

export type StockMovementGroupType =
  | 'SALE'
  | 'ADJUSTMENT'
  | 'PRODUCT'
  | 'BACKORDER';

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

/**
 * Units a backorder holds in one bucket, derived from its `BACKORDER_RESERVE`
 * minus `BACKORDER_RELEASE` movements (restock-backorder T2a). Always > 0.
 */
export interface HeldBackorderBucket {
  bucketKind: StockBucketKind;
  productId: string;
  variantId: string | null;
  lotId: string | null;
  held: number;
}

/** `BACKORDER_RESERVE`/`BACKORDER_RELEASE` row fields the held-bucket fold needs. */
export interface BackorderMovementRecord {
  bucketKind: StockBucketKind;
  productId: string;
  variantId: string | null;
  lotId: string | null;
  delta: number;
}

/** Reserves `quantity` sellable units for one backorder (FEFO over non-expired lots for lot-tracked products). */
export interface BackorderReserveInput {
  backorderId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  actor: StockActor;
}

export interface BackorderReleaseInput {
  backorderId: string;
  actor: StockActor;
  /** Release only what is held in these lots (lot swap); omitted = everything. */
  lotIds?: readonly string[];
  /**
   * Run the stock-increase listeners (backorder allocation) after the release.
   * Default true; the lot-swap primitive turns it off and allocates itself once
   * the backorder row is consistent.
   */
  allocate?: boolean;
}

export type BackorderRevalidation =
  /** The backorder holds nothing in the journal (never reserved or already released). */
  | { status: 'NOT_HELD'; movements: [] }
  /** No held lot has expired: nothing written. */
  | { status: 'VALID'; movements: [] }
  /** Expired-lot units released and the same quantity re-reserved from valid stock. */
  | { status: 'SWAPPED'; movements: AppliedStockMovement[] }
  /** Valid stock cannot cover it: everything released; the caller sends the backorder back to WAITING. */
  | { status: 'LOST'; movements: AppliedStockMovement[] };

/** Product/variant whose sellable quantity just went up in this transaction. */
export interface StockIncreaseTarget {
  productId: string;
  variantId: string | null;
}

/**
 * Observer of stock increases (the backorder allocator). Called by the journal
 * writer INSIDE the writer's transaction, after the increase was persisted and
 * while its product/lot/variant locks are held. Returns the movements it
 * wrote (appended to the caller's result so the low-stock edge sees the net
 * balance change).
 */
export interface StockIncreaseListener {
  onStockIncreased(
    targets: StockIncreaseTarget[],
    now: Date,
  ): Promise<AppliedStockMovement[]>;
}
