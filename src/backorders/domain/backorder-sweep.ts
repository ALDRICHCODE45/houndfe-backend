/**
 * Pure decision of the backorder sweep's timers (restock-backorder T2b,
 * contract v1 §4): from a locked `RESERVED` row and the clock, what happens
 * now. No I/O: the sweep store feeds it the row it holds `FOR UPDATE` and
 * executes the plan.
 *
 * `reservationStage` makes each step exactly-once (like the hold's
 * `holdStage`): 0 nothing sent, 1 reminded, 2 expired.
 */
import type { BackorderStatusValue } from './backorder-status';

export const RESERVATION_STAGE = {
  NONE: 0,
  REMINDED: 1,
  EXPIRED: 2,
} as const;

/** The timer columns of a backorder, as read under the row lock. */
export interface ReservationClock {
  status: BackorderStatusValue;
  reservationStage: number;
  reservedUntil: Date | null;
  reminderAt: Date | null;
}

export type ReservationStep =
  | { kind: 'wait' }
  | { kind: 'remind' }
  | { kind: 'expire' };

/**
 * - not an open reservation (not RESERVED, stage 2, no deadline) → wait;
 * - `reservedUntil <= now` → expire (from stage 0 or 1; a lapsed reservation is
 *   never reminded: a reminder after the deadline is useless);
 * - stage 0 and `reminderAt <= now` → remind;
 * - otherwise wait.
 */
export function planReservationStep(
  row: ReservationClock,
  now: Date,
): ReservationStep {
  if (
    row.status !== 'RESERVED' ||
    row.reservationStage >= RESERVATION_STAGE.EXPIRED ||
    row.reservedUntil === null
  ) {
    return { kind: 'wait' };
  }
  if (row.reservedUntil.getTime() <= now.getTime()) return { kind: 'expire' };
  if (
    row.reservationStage === RESERVATION_STAGE.NONE &&
    row.reminderAt !== null &&
    row.reminderAt.getTime() <= now.getTime()
  ) {
    return { kind: 'remind' };
  }
  return { kind: 'wait' };
}

/** The `reservationStage` a step leaves behind. */
export const STAGE_AFTER = {
  remind: RESERVATION_STAGE.REMINDED,
  expire: RESERVATION_STAGE.EXPIRED,
} as const;
