import {
  HOLD_DEFAULT_DURATION_MS,
  HOLD_REMINDER_LEAD_MS,
  holdReminderAt,
  toSaleHoldView,
} from './sale-hold';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-18T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('sale hold rules (pay-in-store-pickup / T1)', () => {
  it('defaults to 24 h with the reminder 3 h before (S3, S5)', () => {
    expect(HOLD_DEFAULT_DURATION_MS).toBe(24 * HOUR);
    expect(HOLD_REMINDER_LEAD_MS).toBe(3 * HOUR);
    expect(holdReminderAt(at(24 * HOUR), NOW)).toEqual(at(21 * HOUR));
  });

  it('skips the reminder when the hold is 3 h or shorter (reminder not in the future)', () => {
    expect(holdReminderAt(at(3 * HOUR + 1), NOW)).toEqual(at(1));
    expect(holdReminderAt(at(3 * HOUR), NOW)).toBeNull();
    expect(holdReminderAt(at(2 * HOUR), NOW)).toBeNull();
  });

  it('maps the columns to the wire view, null without an intent', () => {
    expect(
      toSaleHoldView({
        paymentIntent: null,
        holdExpiresAt: null,
        holdReminderAt: null,
        holdStage: 0,
        holdVersion: 0,
      }),
    ).toBeNull();
    expect(
      toSaleHoldView({
        paymentIntent: 'IN_STORE',
        holdExpiresAt: at(2 * HOUR),
        holdReminderAt: null,
        holdStage: 1,
        holdVersion: 3,
      }),
    ).toEqual({
      paymentIntent: 'IN_STORE',
      expiresAt: '2026-11-18T14:00:00.000Z',
      reminderAt: null,
      stage: 1,
      version: 3,
    });
  });
});
