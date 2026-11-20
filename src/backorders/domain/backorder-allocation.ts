/**
 * Pure rules of the backorder allocator (contract v1 §4, §5; owner Q1, Q2/Q3,
 * D1, D3). No I/O: the allocator feeds it the locked queue, the sellable
 * quantity and a price lookup, then executes the plan it returns.
 */

/** Hours a reservation stays open from the moment of reservation (D3). */
export const RESERVATION_HOURS = 24;
/** The reminder fires this many hours before `reservedUntil`. */
export const REMINDER_LEAD_HOURS = 3;

const HOUR_MS = 3_600_000;

export interface QueuedBackorder {
  id: string;
  quantity: number;
  customerId: string;
  referencePriceCents: number;
}

export interface PlannedReservation {
  backorder: QueuedBackorder;
  /** That customer's bot price for the quantity today, auto promotions included. */
  currentPriceCents: number;
  /** `min(reference, current)` (D1). */
  finalPriceCents: number;
}

export interface QueueWalk {
  /** In queue order. */
  reservations: PlannedReservation[];
  /** Did not fit and had a reservation behind it in this pass (Q1). */
  passedOverIds: string[];
  /** Fitted but no price could be computed: left WAITING, stock untouched. */
  unpricedIds: string[];
  /** Sellable units left after the plan. */
  remaining: number;
}

export interface ReservationWindow {
  reservedAt: Date;
  reservedUntil: Date;
  reminderAt: Date;
}

/** 24 h from reservation; the reminder 3 h before the end (like the pay-in-store hold). */
export function reservationWindow(now: Date): ReservationWindow {
  const reservedUntil = new Date(now.getTime() + RESERVATION_HOURS * HOUR_MS);
  return {
    reservedAt: now,
    reservedUntil,
    reminderAt: new Date(
      reservedUntil.getTime() - REMINDER_LEAD_HOURS * HOUR_MS,
    ),
  };
}

/**
 * Unit price from a priced line total. Promotions such as buy-X-get-Y leave a
 * line total that is not a multiple of the quantity; rounding DOWN keeps
 * `unit * quantity <= line total`, so the backorder customer never pays more
 * than a counter customer would that day (owner Q2).
 */
export function unitPriceFromLine(
  lineFinalCents: number,
  quantity: number,
): number {
  return Math.max(Math.floor(lineFinalCents / quantity), 0);
}

/**
 * Walks the WHOLE queue (already ordered by `scheduledAt, id`): every backorder
 * whose full quantity fits the units still sellable is planned for reservation
 * and shrinks the remainder; one that does not fit keeps its place (no partial
 * reservation). A non-fitting backorder is "passed over" when a backorder
 * behind it was reserved in this same pass (counted once per pass).
 *
 * A fitting backorder whose price cannot be justified (`priceOf` → null) is not
 * reserved and does not consume stock, so those units stay for the next one.
 */
export async function walkQueue(input: {
  queue: readonly QueuedBackorder[];
  sellable: number;
  priceOf: (backorder: QueuedBackorder) => Promise<number | null>;
}): Promise<QueueWalk> {
  let remaining = Math.max(input.sellable, 0);
  const reservations: PlannedReservation[] = [];
  const unpricedIds: string[] = [];
  /** Non-fitting backorders still waiting for someone behind them to be reserved. */
  let pending: string[] = [];
  const passedOverIds: string[] = [];

  for (const backorder of input.queue) {
    if (backorder.quantity > remaining) {
      pending.push(backorder.id);
      continue;
    }
    const currentPriceCents = await input.priceOf(backorder);
    if (currentPriceCents === null) {
      unpricedIds.push(backorder.id);
      continue;
    }
    reservations.push({
      backorder,
      currentPriceCents,
      finalPriceCents: Math.min(
        backorder.referencePriceCents,
        currentPriceCents,
      ),
    });
    remaining -= backorder.quantity;
    // Someone behind these was reserved: every earlier miss is passed over.
    passedOverIds.push(...pending);
    pending = [];
  }
  return { reservations, passedOverIds, unpricedIds, remaining };
}
