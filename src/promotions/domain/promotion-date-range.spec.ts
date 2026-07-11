/**
 * Promotion date-range normalization — pure helpers (RED tests).
 *
 * The frontend sends date-only inputs as **UTC midnight** (e.g.
 * "2026-07-11T00:00:00.000Z" for the user-picked day "11 July"). Storing
 * that instant verbatim and comparing against `now` in UTC makes the
 * promotion window drift by the business timezone's offset — at
 * UTC-6 (America/Mexico_City) a promo ending 2026-07-11 is considered
 * ENDED ~6 hours before the local midnight the user actually picked.
 *
 * Contract these helpers enforce:
 *
 *   1. The **intended calendar day** is the UTC date-component of the
 *      incoming `Date` (YYYY-MM-DD). That is the day the user picked
 *      on the frontend date picker — the picker serializes the picked
 *      day as UTC-midnight, so the UTC date part IS the business day.
 *
 *   2. `startOfBusinessDay(input, tz)` → the UTC instant of
 *      `<calendarDay> 00:00:00.000` IN THE BUSINESS TIMEZONE.
 *
 *   3. `endOfBusinessDay(input, tz)` → the UTC instant of
 *      `<calendarDay> 23:59:59.999` IN THE BUSINESS TIMEZONE.
 *
 *   4. Bounds are inclusive: a promo whose window includes the local
 *      business day stays ACTIVE through the entire local day. With
 *      `getEffectiveStatus` (`endDate < now ⇒ ENDED`), the inclusive
 *      end instant ensures the promo is still eligible up to the very
 *      last millisecond of the local day.
 *
 *   5. Offset is computed via `Intl.DateTimeFormat({ timeZone })` —
 *      DST-safe for any IANA zone, including zones Mexico abolished
 *      DST in (current America/Mexico_City is UTC-6 year-round).
 */
import {
  startOfBusinessDay,
  endOfBusinessDay,
  normalizePromotionDateRange,
} from './promotion-date-range';

describe('startOfBusinessDay', () => {
  it('returns local midnight as UTC for America/Mexico_City (UTC-6, no DST)', () => {
    // The frontend sends "2026-07-01T00:00:00.000Z" for the user-picked
    // day "1 July". The UTC date-component is "2026-07-01" — that is
    // the intended business day. Local midnight on 1 July in
    // America/Mexico_City is 06:00:00.000 UTC (UTC-6).
    const input = new Date('2026-07-01T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'America/Mexico_City');
    expect(result.toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });

  it('uses the UTC date-component of the input as the intended business day (contract anchor)', () => {
    // The frontend's UTC-midnight serialization means "2026-07-11T00:00:00Z"
    // is the user-picked "11 July". We must NOT shift to "10 July" even
    // though the UTC instant lies in Mexico's July 10.
    const input = new Date('2026-07-11T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'America/Mexico_City');
    expect(result.toISOString()).toBe('2026-07-11T06:00:00.000Z');
  });

  it('returns the canonical UTC midnight when the business timezone is UTC', () => {
    const input = new Date('2026-07-01T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'UTC');
    expect(result.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('respects DST — America/New_York in July (UTC-4 in DST)', () => {
    // July 11 2026 is in DST for NYC (EDT = UTC-4).
    const input = new Date('2026-07-11T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'America/New_York');
    expect(result.toISOString()).toBe('2026-07-11T04:00:00.000Z');
  });

  it('respects DST — America/New_York in January (UTC-5 in standard time)', () => {
    const input = new Date('2026-01-11T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'America/New_York');
    expect(result.toISOString()).toBe('2026-01-11T05:00:00.000Z');
  });

  it('computes the offset via the zone, NOT a hardcoded constant (DST-correctness regression)', () => {
    // Two distinct zones with different offsets on the SAME calendar day
    // must produce different results. If a hardcoded -6 (or any
    // non-zone-aware offset) is used, this test fails.
    const input = new Date('2026-07-11T00:00:00.000Z');
    const mexicoCity = startOfBusinessDay(input, 'America/Mexico_City');
    const newYork = startOfBusinessDay(input, 'America/New_York');
    expect(mexicoCity.toISOString()).not.toBe(newYork.toISOString());
    // Mexico City is UTC-6; New York in July is UTC-4 → NYC's local
    // midnight is 2h earlier in UTC than Mexico City's. We assert the
    // magnitude of the delta to make the test immune to which side we
    // pick for the subtraction.
    const diffHours =
      Math.abs(newYork.getTime() - mexicoCity.getTime()) / (60 * 60 * 1000);
    expect(diffHours).toBe(2);
  });

  it('throws on an unknown IANA timezone (fail-loud at the boundary)', () => {
    const input = new Date('2026-07-01T00:00:00.000Z');
    expect(() => startOfBusinessDay(input, 'Atlantis/Lemuria')).toThrow(
      /timezone/i,
    );
  });

  it('handles far-future dates the same way (no special-casing of year)', () => {
    const input = new Date('2099-12-31T00:00:00.000Z');
    const result = startOfBusinessDay(input, 'America/Mexico_City');
    expect(result.toISOString()).toBe('2099-12-31T06:00:00.000Z');
  });
});

describe('endOfBusinessDay', () => {
  it('returns local 23:59:59.999 as UTC for America/Mexico_City (UTC-6)', () => {
    // "11 July" in Mexico City → end-of-day = July 11 23:59:59.999 local
    // = July 12 05:59:59.999 UTC.
    const input = new Date('2026-07-11T00:00:00.000Z');
    const result = endOfBusinessDay(input, 'America/Mexico_City');
    expect(result.toISOString()).toBe('2026-07-12T05:59:59.999Z');
  });

  it('returns local 23:59:59.999 as UTC for America/Mexico_City on July 1', () => {
    const input = new Date('2026-07-01T00:00:00.000Z');
    const result = endOfBusinessDay(input, 'America/Mexico_City');
    expect(result.toISOString()).toBe('2026-07-02T05:59:59.999Z');
  });

  it('returns canonical UTC end-of-day when business timezone is UTC', () => {
    const input = new Date('2026-07-11T00:00:00.000Z');
    const result = endOfBusinessDay(input, 'UTC');
    expect(result.toISOString()).toBe('2026-07-11T23:59:59.999Z');
  });

  it('endOfBusinessDay is exactly startOfBusinessDay + 24h - 1ms (no off-by-one)', () => {
    const input = new Date('2026-07-11T00:00:00.000Z');
    const start = startOfBusinessDay(input, 'America/Mexico_City').getTime();
    const end = endOfBusinessDay(input, 'America/Mexico_City').getTime();
    expect(end - start).toBe(86_399_999);
  });

  it('respects DST for America/New_York in July (UTC-4)', () => {
    const input = new Date('2026-07-11T00:00:00.000Z');
    const result = endOfBusinessDay(input, 'America/New_York');
    expect(result.toISOString()).toBe('2026-07-12T03:59:59.999Z');
  });

  it('respects DST for America/New_York in January (UTC-5)', () => {
    const input = new Date('2026-01-11T00:00:00.000Z');
    const result = endOfBusinessDay(input, 'America/New_York');
    expect(result.toISOString()).toBe('2026-01-12T04:59:59.999Z');
  });

  it('throws on an unknown IANA timezone', () => {
    const input = new Date('2026-07-01T00:00:00.000Z');
    expect(() => endOfBusinessDay(input, 'Atlantis/Lemuria')).toThrow(
      /timezone/i,
    );
  });
});

describe('normalizePromotionDateRange', () => {
  it('normalizes both bounds; nulls pass through', () => {
    const input = {
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-11T00:00:00.000Z'),
    };
    const result = normalizePromotionDateRange(input, 'America/Mexico_City');
    expect(result.startDate?.toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-07-12T05:59:59.999Z');
  });

  it('preserves null startDate when only endDate is provided', () => {
    const result = normalizePromotionDateRange(
      { startDate: null, endDate: new Date('2026-07-11T00:00:00.000Z') },
      'America/Mexico_City',
    );
    expect(result.startDate).toBeNull();
    expect(result.endDate?.toISOString()).toBe('2026-07-12T05:59:59.999Z');
  });

  it('preserves null endDate when only startDate is provided', () => {
    const result = normalizePromotionDateRange(
      { startDate: new Date('2026-07-01T00:00:00.000Z'), endDate: null },
      'America/Mexico_City',
    );
    expect(result.startDate?.toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(result.endDate).toBeNull();
  });

  it('preserves both nulls (open-ended window)', () => {
    const result = normalizePromotionDateRange(
      { startDate: null, endDate: null },
      'America/Mexico_City',
    );
    expect(result.startDate).toBeNull();
    expect(result.endDate).toBeNull();
  });

  it('end-of-day stays ≥ start-of-day after normalization (validateDateRange invariant)', () => {
    const result = normalizePromotionDateRange(
      {
        startDate: new Date('2026-07-11T00:00:00.000Z'),
        endDate: new Date('2026-07-11T00:00:00.000Z'),
      },
      'America/Mexico_City',
    );
    expect(result.startDate!.getTime()).toBeLessThanOrEqual(
      result.endDate!.getTime(),
    );
  });

  it('uses the configured timezone (env override scenario)', () => {
    const result = normalizePromotionDateRange(
      {
        startDate: new Date('2026-07-01T00:00:00.000Z'),
        endDate: new Date('2026-07-11T00:00:00.000Z'),
      },
      'UTC',
    );
    expect(result.startDate?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-07-11T23:59:59.999Z');
  });
});
