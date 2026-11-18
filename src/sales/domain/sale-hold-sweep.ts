/**
 * pay-in-store-pickup / T2 (S2, S3, S4) — what the hold sweep does with ONE
 * pay-in-store sale, decided from the row as it is under the sweep's lock.
 * Pure: the store reads the facts and applies the plan.
 *
 *   - `remind`       S3: stage 0, reminder due, deadline not reached, the sale
 *                    is still an unpaid CONFIRMED CREDIT hold -> customer
 *                    reminder (`sale.pickup_reminder`), stage 1.
 *   - `skipReminder` the reminder is due but something was already paid
 *                    (PARTIAL): no customer reminder, stage 1, so the expiry
 *                    stage still reviews the payment (S4).
 *   - `expire`       S2: deadline reached, CONFIRMED, CREDIT, nothing paid,
 *                    no PENDING receipt -> cancel HOLD_EXPIRED, release the
 *                    stock, tell the customer (`sale.pickup_expired`), stage 2.
 *   - `review`       S4: deadline reached with a payment or a PENDING receipt
 *                    -> no cancel; one staff notice to decide (and refund if
 *                    needed), stage 2.
 *   - `settle`       the hold is over without output: the sale was cancelled,
 *                    fully paid, handed over, or is no longer CREDIT -> stage
 *                    2 so it leaves the due index (L3).
 *   - `wait`         nothing is due (a stale candidate).
 */
import { HOLD_STAGE } from './sale-hold';

export interface HoldSweepFacts {
  status: string;
  paymentStatus: string | null;
  paidCents: number;
  deliveryStatus: string;
  holdStage: number;
  holdExpiresAt: Date | null;
  holdReminderAt: Date | null;
  /** A `receipt_evidences` row of the sale is PENDING (read only at expiry). */
  pendingReceipt: boolean;
}

export type HoldReviewReason = 'PAYMENT_RECEIVED' | 'RECEIPT_PENDING';

export type HoldSweepPlan =
  | { kind: 'remind' }
  | { kind: 'skipReminder' }
  | { kind: 'expire' }
  | { kind: 'review'; reason: HoldReviewReason }
  | { kind: 'settle' }
  | { kind: 'wait' };

/** `holdStage` written for each plan (`wait` writes nothing). */
export const STAGE_AFTER: Record<
  Exclude<HoldSweepPlan['kind'], 'wait'>,
  number
> = {
  remind: HOLD_STAGE.REMINDED,
  skipReminder: HOLD_STAGE.REMINDED,
  expire: HOLD_STAGE.EXPIRED,
  review: HOLD_STAGE.EXPIRED,
  settle: HOLD_STAGE.EXPIRED,
};

const HANDED_OVER: ReadonlySet<string> = new Set(['SHIPPED', 'DELIVERED']);

export function planHoldStep(facts: HoldSweepFacts, now: Date): HoldSweepPlan {
  if (facts.holdStage >= HOLD_STAGE.EXPIRED || !facts.holdExpiresAt) {
    return { kind: 'wait' };
  }
  const expired = facts.holdExpiresAt.getTime() <= now.getTime();
  const reminderDue =
    facts.holdStage === HOLD_STAGE.NONE &&
    facts.holdReminderAt !== null &&
    facts.holdReminderAt.getTime() <= now.getTime();
  if (!expired && !reminderDue) return { kind: 'wait' };

  // Over without output, whichever stage was due.
  if (facts.status !== 'CONFIRMED' || facts.paymentStatus === 'PAID') {
    return { kind: 'settle' };
  }
  const paid = facts.paidCents > 0;

  if (!expired) {
    if (paid) return { kind: 'skipReminder' };
    return facts.paymentStatus === 'CREDIT'
      ? { kind: 'remind' }
      : { kind: 'settle' };
  }

  // A handed-over sale cannot be cancelled (`SaleDeliveredCannotCancelError`).
  if (HANDED_OVER.has(facts.deliveryStatus)) return { kind: 'settle' };
  if (paid) return { kind: 'review', reason: 'PAYMENT_RECEIVED' };
  if (facts.paymentStatus !== 'CREDIT') return { kind: 'settle' };
  if (facts.pendingReceipt)
    return { kind: 'review', reason: 'RECEIPT_PENDING' };
  return { kind: 'expire' };
}
