import {
  planReservationStep,
  RESERVATION_STAGE,
  STAGE_AFTER,
  type ReservationClock,
} from './backorder-sweep';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const ms = (n: number) => new Date(NOW.getTime() + n);
const HOUR = 3_600_000;

const row = (over: Partial<ReservationClock> = {}): ReservationClock => ({
  status: 'RESERVED',
  reservationStage: 0,
  reservedUntil: ms(10 * HOUR),
  reminderAt: ms(7 * HOUR),
  ...over,
});

describe('planReservationStep (restock-backorder T2b, contract §4)', () => {
  it('waits before the reminder', () => {
    expect(planReservationStep(row(), NOW)).toEqual({ kind: 'wait' });
  });

  it('reminds when reminderAt passed and nothing was sent (stage 0)', () => {
    expect(planReservationStep(row({ reminderAt: ms(-1) }), NOW)).toEqual({
      kind: 'remind',
    });
    // At the exact instant it is due.
    expect(planReservationStep(row({ reminderAt: NOW }), NOW)).toEqual({
      kind: 'remind',
    });
  });

  it('never reminds twice: stage 1 waits for the deadline', () => {
    expect(
      planReservationStep(
        row({
          reservationStage: RESERVATION_STAGE.REMINDED,
          reminderAt: ms(-5),
        }),
        NOW,
      ),
    ).toEqual({ kind: 'wait' });
  });

  it('expires at the deadline, from stage 0 or 1', () => {
    for (const stage of [0, 1]) {
      expect(
        planReservationStep(
          row({ reservationStage: stage, reservedUntil: ms(-1) }),
          NOW,
        ),
      ).toEqual({ kind: 'expire' });
    }
    expect(planReservationStep(row({ reservedUntil: NOW }), NOW)).toEqual({
      kind: 'expire',
    });
  });

  it('a lapsed reservation is expired, never reminded (no reminder after the deadline)', () => {
    expect(
      planReservationStep(
        row({ reminderAt: ms(-4 * HOUR), reservedUntil: ms(-HOUR) }),
        NOW,
      ),
    ).toEqual({ kind: 'expire' });
  });

  it('leaves alone everything that is not an open reservation', () => {
    expect(planReservationStep(row({ status: 'WAITING' }), NOW)).toEqual({
      kind: 'wait',
    });
    expect(planReservationStep(row({ status: 'CONFIRMED' }), NOW)).toEqual({
      kind: 'wait',
    });
    expect(planReservationStep(row({ status: 'CANCELLED' }), NOW)).toEqual({
      kind: 'wait',
    });
    expect(
      planReservationStep(
        row({
          reservationStage: RESERVATION_STAGE.EXPIRED,
          reservedUntil: ms(-1),
        }),
        NOW,
      ),
    ).toEqual({ kind: 'wait' });
    expect(
      planReservationStep(row({ reservedUntil: null, reminderAt: null }), NOW),
    ).toEqual({ kind: 'wait' });
  });

  it('the stage written after each step', () => {
    expect(STAGE_AFTER).toEqual({ remind: 1, expire: 2 });
  });
});
