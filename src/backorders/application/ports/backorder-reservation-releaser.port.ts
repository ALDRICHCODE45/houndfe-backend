/**
 * Seam between cancelling a backorder and the stock journal.
 *
 * A `RESERVED` backorder holds units taken out of the sellable stock by a
 * `BACKORDER_RESERVE` movement (contract v1 §3). Cancelling it must hand those
 * units back (`BACKORDER_RELEASE`) in the same transaction as the status
 * change, and let the allocator serve the next waiting backorder (§4).
 *
 * The cancel use case calls `releaseReservation` for every backorder it cancels
 * out of `RESERVED`, inside its transaction. T1 binds the no-op adapter: no
 * backorder can be `RESERVED` before the reserve/allocate task creates the
 * journal movement, so there is nothing to release yet. That task replaces the
 * binding of this token; the cancel use case does not change.
 */
export interface BackorderReservationRef {
  tenantId: string;
  backorderId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface BackorderReservationReleaser {
  releaseReservation(reservation: BackorderReservationRef): Promise<void>;
}

export const BACKORDER_RESERVATION_RELEASER = Symbol(
  'BACKORDER_RESERVATION_RELEASER',
);
