import type {
  OpeningDay,
  Weekday,
} from '../../shipping/pickup/domain/opening-hours';
import {
  BusinessCalendarError,
  createBusinessCalendar,
} from './business-hours-calendar';

/**
 * Fixtures. Instants are written as ISO strings WITH their UTC offset, so each
 * expectation shows both the wall clock the owner sees and the real instant.
 * America/Mexico_City has no DST since 2022 (offset -06:00 in 2026) but the
 * historical 2021 rules are exercised too; New York and London cover the
 * spring-forward and fall-back changes of 2026.
 */
const DAY_NAMES: Weekday[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

function week(open: string, close: string, openDays: Weekday[]): OpeningDay[] {
  return DAY_NAMES.map((day) => ({
    day,
    ranges: openDays.includes(day) ? [{ open, close }] : [],
  }));
}

const MON_SAT: Weekday[] = DAY_NAMES.slice(0, 6);
const MON_FRI: Weekday[] = DAY_NAMES.slice(0, 5);

const mexico = (closedDates: string[] = []) =>
  createBusinessCalendar({
    timeZone: 'America/Mexico_City',
    days: week('09:00', '19:00', MON_SAT),
    closedDates,
  });

const newYork = () =>
  createBusinessCalendar({
    timeZone: 'America/New_York',
    days: week('09:00', '17:00', MON_FRI),
    closedDates: [],
  });

const iso = (date: Date) => date.toISOString();
const at = (value: string) => new Date(value);

describe('createBusinessCalendar', () => {
  it('rejects a zone that is not IANA', () => {
    expect(() =>
      createBusinessCalendar({
        timeZone: 'Mars/Olympus',
        days: week('09:00', '19:00', MON_SAT),
        closedDates: [],
      }),
    ).toThrow(BusinessCalendarError);
  });

  it('rejects a week without a single open range', () => {
    expect(() =>
      createBusinessCalendar({
        timeZone: 'America/Mexico_City',
        days: week('09:00', '19:00', []),
        closedDates: [],
      }),
    ).toThrow(BusinessCalendarError);
  });

  it('rejects a malformed closed date', () => {
    expect(() =>
      createBusinessCalendar({
        timeZone: 'America/Mexico_City',
        days: week('09:00', '19:00', MON_SAT),
        closedDates: ['2026-02-30'],
      }),
    ).toThrow(BusinessCalendarError);
  });
});

describe('addBusinessMinutes (Mexico City, Mon-Sat 09:00-19:00)', () => {
  const cal = mexico();

  it('adds inside the same business day', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T10:00:00-06:00'), 30)),
    ).toBe(iso(at('2026-11-09T10:30:00-06:00')));
  });

  it('lands exactly on the close instead of rolling to the next day', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T18:30:00-06:00'), 30)),
    ).toBe(iso(at('2026-11-09T19:00:00-06:00')));
  });

  it('rolls one minute past the close to the next opening', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T18:30:00-06:00'), 31)),
    ).toBe(iso(at('2026-11-10T09:01:00-06:00')));
  });

  it('pauses the clock after the close', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T20:00:00-06:00'), 10)),
    ).toBe(iso(at('2026-11-10T09:10:00-06:00')));
  });

  it('starts counting at the opening when it begins before it', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T07:00:00-06:00'), 10)),
    ).toBe(iso(at('2026-11-09T09:10:00-06:00')));
  });

  it('skips a closed Sunday', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-14T18:50:00-06:00'), 20)),
    ).toBe(iso(at('2026-11-16T09:10:00-06:00')));
  });

  it('starts from a closed Sunday on Monday morning', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-15T12:00:00-06:00'), 60)),
    ).toBe(iso(at('2026-11-16T10:00:00-06:00')));
  });

  it('spans several days', () => {
    // Mon 600 + Tue 600 business minutes, the remaining 300 on Wednesday.
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T09:00:00-06:00'), 1500)),
    ).toBe(iso(at('2026-11-11T14:00:00-06:00')));
  });

  it('keeps fractions of a minute of the start instant', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T10:00:30.250-06:00'), 1)),
    ).toBe(iso(at('2026-11-09T10:01:30.250-06:00')));
  });

  it('returns the start for zero minutes inside hours', () => {
    const from = at('2026-11-09T10:00:00-06:00');
    expect(iso(cal.addBusinessMinutes(from, 0))).toBe(iso(from));
  });

  it('returns the next opening for zero minutes outside hours', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T21:00:00-06:00'), 0)),
    ).toBe(iso(at('2026-11-10T09:00:00-06:00')));
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s minutes',
    (minutes) => {
      expect(() =>
        cal.addBusinessMinutes(at('2026-11-09T10:00:00-06:00'), minutes),
      ).toThrow(RangeError);
    },
  );
});

describe('addBusinessMinutes with closed dates', () => {
  // 2026-11-16 (Monday) is a holiday.
  const cal = mexico(['2026-11-16']);

  it('treats the closed Monday as no business time', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-14T18:50:00-06:00'), 20)),
    ).toBe(iso(at('2026-11-17T09:10:00-06:00')));
  });

  it('starts a request created on the closed day at the next opening', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-16T10:00:00-06:00'), 30)),
    ).toBe(iso(at('2026-11-17T09:30:00-06:00')));
  });

  it('closes a normally open weekday in the middle of the week', () => {
    const midweek = mexico(['2026-11-11']);
    expect(
      iso(midweek.addBusinessMinutes(at('2026-11-10T18:50:00-06:00'), 20)),
    ).toBe(iso(at('2026-11-12T09:10:00-06:00')));
  });

  it('gives up with an error when closed dates cover the whole scan horizon', () => {
    const closed: string[] = [];
    const start = Date.UTC(2026, 10, 9);
    for (let i = 0; i < 801; i++) {
      closed.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    }
    const shut = mexico(closed);
    expect(() =>
      shut.addBusinessMinutes(at('2026-11-09T10:00:00-06:00'), 30),
    ).toThrow(BusinessCalendarError);
    expect(() =>
      shut.receiptDeadline(at('2026-11-09T10:00:00-06:00'), 60),
    ).toThrow(BusinessCalendarError);
  });
});

describe('addBusinessMinutes with split ranges', () => {
  const cal = createBusinessCalendar({
    timeZone: 'America/Mexico_City',
    days: DAY_NAMES.map((day) => ({
      day,
      ranges: MON_FRI.includes(day)
        ? [
            { open: '09:00', close: '14:00' },
            { open: '16:00', close: '20:00' },
          ]
        : [],
    })),
    closedDates: [],
  });

  it('jumps the midday break', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T13:50:00-06:00'), 30)),
    ).toBe(iso(at('2026-11-09T16:20:00-06:00')));
  });

  it('starts at the second range when it begins during the break', () => {
    expect(
      iso(cal.addBusinessMinutes(at('2026-11-09T14:30:00-06:00'), 10)),
    ).toBe(iso(at('2026-11-09T16:10:00-06:00')));
  });
});

describe('addBusinessMinutes across DST (America/New_York, Mon-Fri 09:00-17:00)', () => {
  const cal = newYork();

  it('counts calendar days, not 24-hour blocks, over the spring-forward weekend', () => {
    // Fri 2026-03-06 16:30 EST (21:30Z); DST starts Sun 03-08. 30 min on
    // Friday, 30 on Monday after 09:00 EDT (13:00Z).
    expect(
      iso(cal.addBusinessMinutes(at('2026-03-06T16:30:00-05:00'), 60)),
    ).toBe('2026-03-09T13:30:00.000Z');
  });

  it('counts calendar days over the fall-back weekend', () => {
    // Fri 2026-10-30 16:30 EDT; DST ends Sun 11-01. Monday 09:00 is EST (14:00Z).
    expect(
      iso(cal.addBusinessMinutes(at('2026-10-30T16:30:00-04:00'), 60)),
    ).toBe('2026-11-02T14:30:00.000Z');
  });

  it('measures a range that contains the spring-forward gap in real minutes', () => {
    // Every day open 01:00-04:00 local. On 2026-03-08 the clock jumps 02:00 to
    // 03:00, so the range lasts 2 real hours: 06:00Z-08:00Z.
    const night = createBusinessCalendar({
      timeZone: 'America/New_York',
      days: week('01:00', '04:00', DAY_NAMES),
      closedDates: [],
    });
    // 01:30 EST is 06:30Z; 90 business minutes end exactly at 08:00Z (close).
    expect(iso(night.addBusinessMinutes(at('2026-03-08T06:30:00Z'), 90))).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    // One more minute rolls to Monday 01:00 EDT (05:00Z) + 1 min.
    expect(iso(night.addBusinessMinutes(at('2026-03-08T06:30:00Z'), 91))).toBe(
      '2026-03-09T05:01:00.000Z',
    );
  });

  it('measures a range that contains the fall-back repeat in real minutes', () => {
    // Every day open 00:00-03:00. On 2026-11-01 the 01:00-02:00 hour happens
    // twice, so the range lasts 4 real hours: 04:00Z-08:00Z.
    const night = createBusinessCalendar({
      timeZone: 'America/New_York',
      days: week('00:00', '03:00', DAY_NAMES),
      closedDates: [],
    });
    expect(iso(night.addBusinessMinutes(at('2026-11-01T04:30:00Z'), 210))).toBe(
      '2026-11-01T08:00:00.000Z',
    );
    expect(iso(night.addBusinessMinutes(at('2026-11-01T04:30:00Z'), 211))).toBe(
      '2026-11-02T05:01:00.000Z',
    );
  });

  it('moves an opening time that does not exist after the gap', () => {
    // Open 02:30-04:00 on the spring-forward day: 02:30 does not exist, it
    // becomes 03:30 EDT (07:30Z), so only 30 real minutes remain until 08:00Z.
    const gap = createBusinessCalendar({
      timeZone: 'America/New_York',
      days: week('02:30', '04:00', DAY_NAMES),
      closedDates: [],
    });
    expect(iso(gap.addBusinessMinutes(at('2026-03-08T06:00:00Z'), 30))).toBe(
      '2026-03-08T08:00:00.000Z',
    );
  });

  it('uses the first occurrence of a repeated wall time', () => {
    // Open 01:30-03:00 on the fall-back day: 01:30 happens at 05:30Z (EDT) and
    // at 06:30Z (EST). The first one opens the range (05:30Z-08:00Z).
    const repeat = createBusinessCalendar({
      timeZone: 'America/New_York',
      days: week('01:30', '03:00', DAY_NAMES),
      closedDates: [],
    });
    expect(iso(repeat.addBusinessMinutes(at('2026-11-01T04:00:00Z'), 30))).toBe(
      '2026-11-01T06:00:00.000Z',
    );
  });

  it('handles the historical Mexico City DST end of 2021', () => {
    // Sat 2021-10-30 18:50 CDT (23:50Z). DST ended Sun 10-31, so Monday 09:00
    // is CST (15:00Z).
    expect(
      iso(mexico().addBusinessMinutes(at('2021-10-30T18:50:00-05:00'), 20)),
    ).toBe('2021-11-01T15:10:00.000Z');
  });

  it('handles the historical Mexico City DST start of 2021', () => {
    // Sat 2021-04-03 18:50 CST (00:50Z next day). DST started Sun 04-04, so
    // Monday 09:00 is CDT (14:00Z).
    expect(
      iso(mexico().addBusinessMinutes(at('2021-04-03T18:50:00-06:00'), 20)),
    ).toBe('2021-04-05T14:10:00.000Z');
  });

  it('handles London summer time', () => {
    const london = createBusinessCalendar({
      timeZone: 'Europe/London',
      days: week('09:00', '17:00', MON_FRI),
      closedDates: [],
    });
    // Fri 2026-03-27 16:30 GMT; BST starts Sun 03-29; Monday 09:00 is 08:00Z.
    expect(iso(london.addBusinessMinutes(at('2026-03-27T16:30:00Z'), 60))).toBe(
      '2026-03-30T08:30:00.000Z',
    );
  });

  it('handles a zone with a half-hour offset', () => {
    const india = createBusinessCalendar({
      timeZone: 'Asia/Kolkata',
      days: week('09:00', '17:00', MON_FRI),
      closedDates: [],
    });
    // 09:00 IST (UTC+05:30) is 03:30Z.
    expect(iso(india.addBusinessMinutes(at('2026-11-09T00:00:00Z'), 30))).toBe(
      '2026-11-09T04:00:00.000Z',
    );
  });
});

describe('businessMinutesBetween', () => {
  const cal = mexico(['2026-11-16']);

  it('counts only business minutes', () => {
    expect(
      cal.businessMinutesBetween(
        at('2026-11-14T18:30:00-06:00'),
        at('2026-11-17T09:30:00-06:00'),
      ),
    ).toBe(60);
  });

  it('is zero for an empty or reversed interval', () => {
    const t = at('2026-11-09T10:00:00-06:00');
    expect(cal.businessMinutesBetween(t, t)).toBe(0);
    expect(cal.businessMinutesBetween(t, at('2026-11-09T09:00:00-06:00'))).toBe(
      0,
    );
  });

  it('is the inverse of addBusinessMinutes, also across DST', () => {
    const calendars = [
      [mexico(['2026-11-16']), at('2026-11-14T17:13:00-06:00')],
      [newYork(), at('2026-03-06T15:07:00-05:00')],
      [newYork(), at('2026-10-30T15:07:00-04:00')],
    ] as const;
    for (const [calendar, from] of calendars) {
      for (const minutes of [1, 59, 60, 61, 599, 600, 601, 1440, 4000]) {
        const to = calendar.addBusinessMinutes(from, minutes);
        expect(calendar.businessMinutesBetween(from, to)).toBe(minutes);
      }
    }
  });
});

describe('isOpenAt', () => {
  const cal = mexico(['2026-11-16']);

  it.each([
    ['2026-11-09T09:00:00-06:00', true],
    ['2026-11-09T18:59:59-06:00', true],
    ['2026-11-09T19:00:00-06:00', false],
    ['2026-11-09T08:59:59-06:00', false],
    ['2026-11-15T12:00:00-06:00', false],
    ['2026-11-16T12:00:00-06:00', false],
  ])('%s -> %s', (instant, expected) => {
    expect(cal.isOpenAt(at(instant))).toBe(expected);
  });
});

describe('receiptDeadline (margin 60)', () => {
  const cal = mexico(['2026-11-16']);
  const deadline = (arrival: string, margin = 60, calendar = cal) =>
    iso(calendar.receiptDeadline(at(arrival), margin));

  it('arrives early in the day: closes that day', () => {
    expect(deadline('2026-11-10T10:00:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('arrives exactly at the opening: closes that day', () => {
    expect(deadline('2026-11-10T09:00:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('arrives 61 minutes before the close: closes that day', () => {
    expect(deadline('2026-11-10T17:59:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('arrives exactly 60 minutes before the close: next business day', () => {
    expect(deadline('2026-11-10T18:00:00-06:00')).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('arrives 59 minutes before the close: next business day', () => {
    expect(deadline('2026-11-10T18:01:00-06:00')).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('arrives exactly at the close: next business day', () => {
    expect(deadline('2026-11-10T19:00:00-06:00')).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('arrives after the close: next business day', () => {
    expect(deadline('2026-11-10T22:30:00-06:00')).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  // Owner decision (L64): «Al cierre de ese mismo día (Recomendado)».
  it('arrives before the opening of a business day: closes that day', () => {
    expect(deadline('2026-11-10T07:30:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
    expect(deadline('2026-11-10T08:59:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('arrives just after local midnight of a business day: closes that day', () => {
    expect(deadline('2026-11-10T00:00:00-06:00')).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('arrives before the opening with a margin larger than the whole day: next business day', () => {
    expect(deadline('2026-11-10T07:30:00-06:00', 601)).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('arrives before the opening of a holiday: next business day', () => {
    expect(deadline('2026-11-16T07:30:00-06:00')).toBe(
      iso(at('2026-11-17T19:00:00-06:00')),
    );
  });

  it('arrives near the Saturday close: skips Sunday to Monday', () => {
    expect(deadline('2026-11-14T18:30:00-06:00', 60, mexico())).toBe(
      iso(at('2026-11-16T19:00:00-06:00')),
    );
  });

  it('arrives early on Saturday: closes Saturday', () => {
    expect(deadline('2026-11-14T10:00:00-06:00')).toBe(
      iso(at('2026-11-14T19:00:00-06:00')),
    );
  });

  it('arrives on a closed Sunday: next business day', () => {
    expect(deadline('2026-11-15T12:00:00-06:00', 60, mexico())).toBe(
      iso(at('2026-11-16T19:00:00-06:00')),
    );
  });

  it('skips a closed holiday (Sunday arrival, Monday closed): Tuesday', () => {
    expect(deadline('2026-11-15T12:00:00-06:00')).toBe(
      iso(at('2026-11-17T19:00:00-06:00')),
    );
  });

  it('arrives during the closed holiday itself: next business day', () => {
    expect(deadline('2026-11-16T10:00:00-06:00')).toBe(
      iso(at('2026-11-17T19:00:00-06:00')),
    );
  });

  it('arrives near the Saturday close before a holiday Monday: Tuesday', () => {
    expect(deadline('2026-11-14T18:30:00-06:00')).toBe(
      iso(at('2026-11-17T19:00:00-06:00')),
    );
  });

  it('honours a different margin on both sides of its boundary', () => {
    expect(deadline('2026-11-10T16:59:00-06:00', 120)).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
    expect(deadline('2026-11-10T17:00:00-06:00', 120)).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('with margin 0 any minute left still closes that day', () => {
    expect(deadline('2026-11-10T18:59:00-06:00', 0)).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
    expect(deadline('2026-11-10T19:00:00-06:00', 0)).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('a margin longer than the whole day always moves to the next business day', () => {
    expect(deadline('2026-11-10T09:00:00-06:00', 700)).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  describe('with a midday break (09-14, 16-20)', () => {
    const split = createBusinessCalendar({
      timeZone: 'America/Mexico_City',
      days: DAY_NAMES.map((day) => ({
        day,
        ranges: MON_FRI.includes(day)
          ? [
              { open: '09:00', close: '14:00' },
              { open: '16:00', close: '20:00' },
            ]
          : [],
      })),
      closedDates: [],
    });

    it('measures the margin in business minutes left that day', () => {
      // 13:30: 30 + 240 business minutes left, closes at 20:00 the same day.
      expect(deadline('2026-11-10T13:30:00-06:00', 60, split)).toBe(
        iso(at('2026-11-10T20:00:00-06:00')),
      );
    });

    it('treats the break as outside hours', () => {
      expect(deadline('2026-11-10T14:30:00-06:00', 60, split)).toBe(
        iso(at('2026-11-11T20:00:00-06:00')),
      );
    });

    it('applies the margin inside the last range', () => {
      expect(deadline('2026-11-10T19:30:00-06:00', 60, split)).toBe(
        iso(at('2026-11-11T20:00:00-06:00')),
      );
    });
  });

  it('works over a DST change (New York, Friday near close before spring forward)', () => {
    // Fri 2026-03-06 16:30 EST (30 min left <= 60): next business day is Monday
    // 2026-03-09, whose 17:00 is EDT (21:00Z).
    expect(deadline('2026-03-06T16:30:00-05:00', 60, newYork())).toBe(
      '2026-03-09T21:00:00.000Z',
    );
  });
});
