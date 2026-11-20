/**
 * restock-backorder / T3 — what a checkout line with `backorderId` must satisfy
 * (contract v1 §7). Pure: the state is the (locked) backorder row. The order of
 * the checks is part of the contract: state, expiry, ownership/shape, price.
 */
import {
  BackorderCheckoutError,
  type BackorderCheckoutLine,
} from '../../sales/domain/backorder-checkout.port';
import type { BackorderStatusValue } from './backorder-status';

export type { BackorderCheckoutLine as CheckoutBackorderLine };

/** The fields of the backorder row the rules read. */
export interface CheckoutBackorderRow {
  id: string;
  status: BackorderStatusValue;
  customerId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  finalPriceCents: number | null;
  reservedUntil: Date | null;
}

/**
 * Returns the frozen unit price (`finalPriceCents`) when the line may confirm
 * the backorder; otherwise throws the `BackorderCheckoutError` of §7:
 *
 *   404 BACKORDER_NOT_FOUND            no such backorder in this sucursal
 *   409 BACKORDER_NOT_RESERVED {status}
 *   409 BACKORDER_RESERVATION_EXPIRED  `reservedUntil` is not after `now`
 *   409 BACKORDER_MISMATCH {field}     customer, product, variant or quantity differ
 *   409 PRICE_OUT_OF_DATE {currentPriceCents}  `unitPriceCents` is not `finalPriceCents`
 */
export function assertBackorderCheckoutable(
  row: CheckoutBackorderRow | null,
  line: BackorderCheckoutLine,
  customerId: string,
  now: Date,
): number {
  if (!row) throw new BackorderCheckoutError('BACKORDER_NOT_FOUND');
  if (row.status !== 'RESERVED') {
    throw new BackorderCheckoutError('BACKORDER_NOT_RESERVED', {
      status: row.status,
    });
  }
  // A RESERVED row always has a deadline (CHECK); without one it is never sellable.
  if (!row.reservedUntil || row.reservedUntil.getTime() <= now.getTime()) {
    throw new BackorderCheckoutError('BACKORDER_RESERVATION_EXPIRED');
  }
  if (row.customerId !== customerId) {
    throw new BackorderCheckoutError('BACKORDER_MISMATCH', {
      field: 'customerId',
    });
  }
  if (row.productId !== line.productId) {
    throw new BackorderCheckoutError('BACKORDER_MISMATCH', {
      field: 'productId',
    });
  }
  if (row.variantId !== (line.variantId ?? null)) {
    throw new BackorderCheckoutError('BACKORDER_MISMATCH', {
      field: 'variantId',
    });
  }
  if (row.quantity !== line.quantity) {
    throw new BackorderCheckoutError('BACKORDER_MISMATCH', {
      field: 'quantity',
    });
  }
  // CHECK `backorders_reserved_state` keeps this non-null while RESERVED.
  if (row.finalPriceCents === null) {
    throw new BackorderCheckoutError('BACKORDER_RESERVATION_UNAVAILABLE');
  }
  if (line.unitPriceCents !== row.finalPriceCents) {
    throw new BackorderCheckoutError('PRICE_OUT_OF_DATE', {
      currentPriceCents: row.finalPriceCents,
    });
  }
  return row.finalPriceCents;
}
