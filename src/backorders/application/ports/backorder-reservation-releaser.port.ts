import type { StockActor } from '../../../inventory/domain/stock-journal.types';

/**
 * Seam between cancelling a backorder and the stock journal.
 *
 * A `RESERVED` backorder holds units taken out of the sellable stock by a
 * `BACKORDER_RESERVE` movement (contract v1 §3). Cancelling it must hand those
 * units back (`BACKORDER_RELEASE`) in the same transaction as the status
 * change, and let the allocator serve the next waiting backorder (§4).
 *
 * The cancel use case calls `releaseReservation` for every backorder it cancels
 * out of `RESERVED`, inside its transaction, AFTER taking the journal locks
 * (stock before the backorder row). T2a binds `BackorderReservationService`:
 * it writes `BACKORDER_RELEASE` and the journal writer serves the next WAITING
 * backorder in the same transaction.
 */
export interface BackorderReservationRef {
  tenantId: string;
  backorderId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Who moves the stock; the system when omitted (sweep). */
  actor?: StockActor;
  /**
   * The instant of the movement and of the allocation it triggers (the sweep's
   * clock); the real clock when omitted.
   */
  now?: Date;
}

export interface BackorderReservationReleaser {
  releaseReservation(reservation: BackorderReservationRef): Promise<void>;
}

export const BACKORDER_RESERVATION_RELEASER = Symbol(
  'BACKORDER_RESERVATION_RELEASER',
);
