import { planHoldStep, type HoldSweepFacts } from './sale-hold-sweep';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-18T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** An unpaid IN_STORE hold whose reminder is due and whose deadline is not. */
const facts = (overrides: Partial<HoldSweepFacts> = {}): HoldSweepFacts => ({
  status: 'CONFIRMED',
  paymentStatus: 'CREDIT',
  paidCents: 0,
  deliveryStatus: 'PENDING',
  holdStage: 0,
  holdExpiresAt: at(2 * HOUR),
  holdReminderAt: at(-HOUR),
  pendingReceipt: false,
  ...overrides,
});

describe('planHoldStep (pay-in-store-pickup / T2)', () => {
  describe('reminder stage (S3)', () => {
    it('reminds an unpaid CONFIRMED CREDIT hold once its reminder is due', () => {
      expect(planHoldStep(facts(), NOW)).toEqual({ kind: 'remind' });
    });

    it('reminds at the exact reminder instant', () => {
      expect(planHoldStep(facts({ holdReminderAt: NOW }), NOW)).toEqual({
        kind: 'remind',
      });
    });

    it('waits while the reminder is not due yet', () => {
      expect(planHoldStep(facts({ holdReminderAt: at(1) }), NOW)).toEqual({
        kind: 'wait',
      });
    });

    it('waits on a hold without a reminder (3 h or shorter) until its deadline', () => {
      expect(planHoldStep(facts({ holdReminderAt: null }), NOW)).toEqual({
        kind: 'wait',
      });
    });

    it('never reminds twice: stage 1 waits for the deadline', () => {
      expect(planHoldStep(facts({ holdStage: 1 }), NOW)).toEqual({
        kind: 'wait',
      });
    });

    it('closes a fully paid hold silently (it must leave the index, L3)', () => {
      expect(planHoldStep(facts({ paymentStatus: 'PAID' }), NOW)).toEqual({
        kind: 'settle',
      });
    });

    it('closes a cancelled sale silently', () => {
      expect(planHoldStep(facts({ status: 'CANCELED' }), NOW)).toEqual({
        kind: 'settle',
      });
    });

    it('sends no reminder to a partially paid hold but keeps it for the expiry review (S4)', () => {
      expect(
        planHoldStep(facts({ paymentStatus: 'PARTIAL', paidCents: 1000 }), NOW),
      ).toEqual({ kind: 'skipReminder' });
    });
  });

  describe('expiry stage (S2, S4)', () => {
    const expired = (overrides: Partial<HoldSweepFacts> = {}) =>
      facts({ holdExpiresAt: NOW, holdStage: 1, ...overrides });

    it('cancels an expired hold with no payment and no pending receipt', () => {
      expect(planHoldStep(expired(), NOW)).toEqual({ kind: 'expire' });
    });

    it('cancels straight from stage 0 when the reminder was missed', () => {
      expect(planHoldStep(expired({ holdStage: 0 }), NOW)).toEqual({
        kind: 'expire',
      });
    });

    it('does not cancel a partially paid hold: staff review', () => {
      expect(
        planHoldStep(expired({ paymentStatus: 'PARTIAL', paidCents: 1 }), NOW),
      ).toEqual({ kind: 'review', reason: 'PAYMENT_RECEIVED' });
    });

    it('does not cancel a hold with a pending receipt: staff review', () => {
      expect(planHoldStep(expired({ pendingReceipt: true }), NOW)).toEqual({
        kind: 'review',
        reason: 'RECEIPT_PENDING',
      });
    });

    it('reports a payment before a pending receipt when both exist', () => {
      expect(
        planHoldStep(
          expired({
            paymentStatus: 'PARTIAL',
            paidCents: 1,
            pendingReceipt: true,
          }),
          NOW,
        ),
      ).toEqual({ kind: 'review', reason: 'PAYMENT_RECEIVED' });
    });

    it('closes a fully paid expired hold silently', () => {
      expect(planHoldStep(expired({ paymentStatus: 'PAID' }), NOW)).toEqual({
        kind: 'settle',
      });
    });

    it('closes a cancelled expired hold silently', () => {
      expect(planHoldStep(expired({ status: 'CANCELED' }), NOW)).toEqual({
        kind: 'settle',
      });
    });

    it('never cancels a sale already handed over (cancel would be refused)', () => {
      expect(
        planHoldStep(expired({ deliveryStatus: 'DELIVERED' }), NOW),
      ).toEqual({ kind: 'settle' });
    });

    it('never cancels a sale that is not CREDIT even with nothing paid', () => {
      expect(planHoldStep(expired({ paymentStatus: null }), NOW)).toEqual({
        kind: 'settle',
      });
    });

    it('waits one millisecond before the deadline', () => {
      expect(planHoldStep(expired({ holdExpiresAt: at(1) }), NOW)).toEqual({
        kind: 'wait',
      });
    });

    it('a finished hold (stage 2) is never acted on again', () => {
      expect(planHoldStep(expired({ holdStage: 2 }), NOW)).toEqual({
        kind: 'wait',
      });
    });
  });
});
