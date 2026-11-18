/**
 * pay-in-store-pickup / T1 — hold rules of a pay-in-store PICKUP sale.
 *
 * S2/S5: the bot marks the intent and the hold lasts 24 h by default; staff
 * move the deadline per sale. S3: the customer reminder goes out exactly 3 h
 * before the deadline, and only when the reminder instant is still in the
 * future (a hold of 3 h or less gets no reminder).
 *
 * T2 expiry eligibility (documented here, enforced by the sweep): a hold
 * expires only while the sale is CONFIRMED, `paymentStatus` CREDIT and
 * `paidCents` 0. Any counter payment (PARTIAL/PAID) takes the sale out of
 * the expiry flow without touching the hold columns.
 */
export type SalePaymentIntent = 'IN_STORE';

export const HOLD_DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
export const HOLD_REMINDER_LEAD_MS = 3 * 60 * 60 * 1000;

/** `holdStage` values written by the T2 sweep. */
export const HOLD_STAGE = { NONE: 0, REMINDED: 1, EXPIRED: 2 } as const;

/** Reminder instant for a deadline, or null when it would not be in the future. */
export function holdReminderAt(expiresAt: Date, now: Date): Date | null {
  const reminderAt = new Date(expiresAt.getTime() - HOLD_REMINDER_LEAD_MS);
  return reminderAt.getTime() > now.getTime() ? reminderAt : null;
}

/** Wire shape of the hold on staff and bot reads. */
export interface SaleHoldView {
  paymentIntent: SalePaymentIntent;
  expiresAt: string | null;
  reminderAt: string | null;
  stage: number;
  version: number;
}

export interface SaleHoldColumns {
  paymentIntent: SalePaymentIntent | null;
  holdExpiresAt: Date | null;
  holdReminderAt: Date | null;
  holdStage: number;
  holdVersion: number;
}

/** `null` for every sale that never declared a payment intent. */
export function toSaleHoldView(row: SaleHoldColumns): SaleHoldView | null {
  if (row.paymentIntent === null) return null;
  return {
    paymentIntent: row.paymentIntent,
    expiresAt: row.holdExpiresAt?.toISOString() ?? null,
    reminderAt: row.holdReminderAt?.toISOString() ?? null,
    stage: row.holdStage,
    version: row.holdVersion,
  };
}

export const SALE_HOLD_SELECT = {
  paymentIntent: true,
  holdExpiresAt: true,
  holdReminderAt: true,
  holdStage: true,
  holdVersion: true,
} as const;
