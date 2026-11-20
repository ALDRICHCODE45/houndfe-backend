/**
 * Backorder states (contract v1 §1):
 *
 *   WAITING ──(stock arrives, T2)──▶ RESERVED ──(bot checkout, T3)──▶ CONFIRMED
 *   RESERVED ──(24 h, T2)──▶ EXPIRED          RESERVED ──(lot expired, T2)──▶ WAITING
 *   WAITING | RESERVED ──(customer or staff cancel)──▶ CANCELLED
 *
 * CONFIRMED, EXPIRED and CANCELLED are terminal. T1 only creates WAITING rows
 * and cancels them; the other edges are written by later tasks.
 */
export const BACKORDER_STATUSES = [
  'WAITING',
  'RESERVED',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type BackorderStatusValue = (typeof BACKORDER_STATUSES)[number];

/** The statuses that count against "one active backorder per customer+product+variant". */
export const ACTIVE_BACKORDER_STATUSES = ['WAITING', 'RESERVED'] as const;

export const BACKORDER_CANCELLED_BY_KINDS = ['STAFF', 'CUSTOMER'] as const;
export type BackorderCancelledByKindValue =
  (typeof BACKORDER_CANCELLED_BY_KINDS)[number];

export function isBackorderStatus(
  value: string,
): value is BackorderStatusValue {
  return (BACKORDER_STATUSES as readonly string[]).includes(value);
}

export function isActiveBackorderStatus(status: BackorderStatusValue): boolean {
  return (ACTIVE_BACKORDER_STATUSES as readonly string[]).includes(status);
}

export type CancelDecision =
  | {
      allowed: true;
      /** A RESERVED backorder holds stock that must be handed back first. */
      releasesReservation: boolean;
    }
  | { allowed: false; status: BackorderStatusValue };

/** WAITING and RESERVED can be cancelled; terminal states cannot (§6.4). */
export function decideCancel(status: BackorderStatusValue): CancelDecision {
  if (status === 'WAITING') {
    return { allowed: true, releasesReservation: false };
  }
  if (status === 'RESERVED') {
    return { allowed: true, releasesReservation: true };
  }
  return { allowed: false, status };
}
