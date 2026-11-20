import {
  ACTIVE_BACKORDER_STATUSES,
  BACKORDER_STATUSES,
  decideCancel,
  isActiveBackorderStatus,
  isBackorderStatus,
} from './backorder-status';

describe('backorder states (contract v1 §1)', () => {
  it('has exactly the five contracted states', () => {
    expect([...BACKORDER_STATUSES]).toEqual([
      'WAITING',
      'RESERVED',
      'CONFIRMED',
      'EXPIRED',
      'CANCELLED',
    ]);
  });

  it('counts only WAITING and RESERVED as active', () => {
    expect([...ACTIVE_BACKORDER_STATUSES]).toEqual(['WAITING', 'RESERVED']);
    expect(isActiveBackorderStatus('WAITING')).toBe(true);
    expect(isActiveBackorderStatus('RESERVED')).toBe(true);
    for (const terminal of ['CONFIRMED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(isActiveBackorderStatus(terminal)).toBe(false);
    }
  });

  it('recognises only known status names', () => {
    expect(isBackorderStatus('WAITING')).toBe(true);
    expect(isBackorderStatus('waiting')).toBe(false);
    expect(isBackorderStatus('PENDING')).toBe(false);
    expect(isBackorderStatus('')).toBe(false);
  });

  describe('decideCancel (§6.4)', () => {
    it('cancels WAITING now, with nothing to release', () => {
      expect(decideCancel('WAITING')).toEqual({
        allowed: true,
        releasesReservation: false,
      });
    });

    it('cancels RESERVED only after releasing its units', () => {
      expect(decideCancel('RESERVED')).toEqual({
        allowed: true,
        releasesReservation: true,
      });
    });

    it.each(['CONFIRMED', 'EXPIRED', 'CANCELLED'] as const)(
      'refuses the terminal state %s and reports it',
      (status) => {
        expect(decideCancel(status)).toEqual({ allowed: false, status });
      },
    );
  });
});
