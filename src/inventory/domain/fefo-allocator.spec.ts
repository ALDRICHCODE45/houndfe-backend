import { allocateFefo, businessToday, isLotExpired } from './fefo-allocator';
import { InsufficientStockError } from './stock-journal.errors';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const lot = (id: string, quantity: number, exp: string) => ({
  id,
  quantity,
  expirationDate: d(exp),
});

describe('businessToday / isLotExpired', () => {
  it('uses the business timezone calendar date, not UTC', () => {
    // 2026-11-05T03:00Z is still Nov 4 in Mexico City (UTC-6).
    const now = new Date('2026-11-05T03:00:00.000Z');
    expect(businessToday(now, 'America/Mexico_City')).toBe('2026-11-04');
    expect(businessToday(now, 'UTC')).toBe('2026-11-05');
  });

  it('expires a lot only when its calendar date is before today', () => {
    expect(isLotExpired(d('2026-11-03'), '2026-11-04')).toBe(true);
    expect(isLotExpired(d('2026-11-04'), '2026-11-04')).toBe(false);
    expect(isLotExpired(d('2026-11-05'), '2026-11-04')).toBe(false);
  });
});

describe('allocateFefo', () => {
  const today = '2026-11-04';

  it('consumes the earliest-expiring lot first and splits across lots', () => {
    const allocations = allocateFefo({
      quantity: 12,
      untrackedAvailable: 0,
      today,
      lots: [lot('b', 10, '2026-12-01'), lot('a', 5, '2026-11-10')],
    });
    expect(allocations).toEqual([
      { lotId: 'a', quantity: 5 },
      { lotId: 'b', quantity: 7 },
    ]);
  });

  it('breaks expiration ties by lot id ascending', () => {
    const allocations = allocateFefo({
      quantity: 3,
      untrackedAvailable: 0,
      today,
      lots: [lot('z', 5, '2026-11-10'), lot('m', 5, '2026-11-10')],
    });
    expect(allocations).toEqual([{ lotId: 'm', quantity: 3 }]);
  });

  it('never sells expired lots and skips empty ones', () => {
    const allocations = allocateFefo({
      quantity: 4,
      untrackedAvailable: 0,
      today,
      lots: [
        lot('old', 50, '2026-11-03'),
        lot('empty', 0, '2026-11-05'),
        lot('ok', 4, '2026-11-20'),
      ],
    });
    expect(allocations).toEqual([{ lotId: 'ok', quantity: 4 }]);
  });

  it('takes the remainder from the untracked portion after the lots', () => {
    const allocations = allocateFefo({
      quantity: 9,
      untrackedAvailable: 10,
      today,
      lots: [lot('a', 4, '2026-11-10')],
    });
    expect(allocations).toEqual([
      { lotId: 'a', quantity: 4 },
      { lotId: null, quantity: 5 },
    ]);
  });

  it('uses only the untracked portion for a product without lots', () => {
    expect(
      allocateFefo({ quantity: 3, untrackedAvailable: 3, today, lots: [] }),
    ).toEqual([{ lotId: null, quantity: 3 }]);
  });

  it('rejects when non-expired lots plus untracked cannot cover the quantity', () => {
    expect(() =>
      allocateFefo({
        quantity: 10,
        untrackedAvailable: 2,
        today,
        lots: [lot('a', 3, '2026-11-10'), lot('old', 100, '2026-01-01')],
      }),
    ).toThrow(InsufficientStockError);
  });

  it('rejects a non-positive quantity', () => {
    expect(() =>
      allocateFefo({ quantity: 0, untrackedAvailable: 5, today, lots: [] }),
    ).toThrow('positive');
  });
});
