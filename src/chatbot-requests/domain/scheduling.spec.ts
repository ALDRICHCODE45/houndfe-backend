import type {
  OpeningDay,
  Weekday,
} from '../../shipping/pickup/domain/opening-hours';
import { createBusinessCalendar } from './business-hours-calendar';
import {
  CLAIM_LEAD_MINUTES,
  HORIZON_DAYS,
  MIN_LEAD_MINUTES,
  REMINDER_LEAD_MINUTES,
  claimableAt,
  isBookableStart,
  isWithinWindow,
  listBookable,
  offerSlots,
  reminderAt,
} from './scheduling';

const DAY_NAMES: Weekday[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];
const week = (open: string, close: string, openDays: Weekday[]): OpeningDay[] =>
  DAY_NAMES.map((day) => ({
    day,
    ranges: openDays.includes(day) ? [{ open, close }] : [],
  }));

const calendar = (closedDates: string[] = []) =>
  createBusinessCalendar({
    timeZone: 'America/Mexico_City',
    days: week('09:00', '19:00', DAY_NAMES.slice(0, 6)),
    closedDates,
  });

const at = (iso: string) => new Date(iso);
const none = new Set<number>();
const iso = (slots: Array<{ startsAt: Date }>) =>
  slots.map((s) => s.startsAt.toISOString());

// 2026-11-09 is a Monday. Mexico City is UTC-6 all year (no DST since 2022).
const MON_8AM = at('2026-11-09T14:00:00.000Z'); // 08:00 local, before opening
const wideWindow = at('2026-11-10T14:00:00.000Z');

describe('scheduling constants (contract §4.9)', () => {
  it('pins the leads: reminder 10 min, claim 5 min, booking at least 10 min ahead, 14 days', () => {
    expect(REMINDER_LEAD_MINUTES).toBe(10);
    expect(CLAIM_LEAD_MINUTES).toBe(5);
    expect(MIN_LEAD_MINUTES).toBe(10);
    expect(HORIZON_DAYS).toBe(14);
  });

  it('derives the reminder and the claim instants from scheduledFor', () => {
    const scheduledFor = at('2026-11-10T15:00:00.000Z');
    expect(reminderAt(scheduledFor).toISOString()).toBe(
      '2026-11-10T14:50:00.000Z',
    );
    expect(claimableAt(scheduledFor).toISOString()).toBe(
      '2026-11-10T14:55:00.000Z',
    );
  });
});

describe('isWithinWindow (§4.9: startsAt + 15 min < window close)', () => {
  const closes = at('2026-11-10T03:10:00.000Z');
  it('is true when the greeting (start + 15 min) is before the close', () => {
    expect(isWithinWindow(at('2026-11-10T02:54:59.000Z'), closes)).toBe(true);
  });
  it('is false at exactly the close and after', () => {
    expect(isWithinWindow(at('2026-11-10T02:55:00.000Z'), closes)).toBe(false);
    expect(isWithinWindow(at('2026-11-10T04:00:00.000Z'), closes)).toBe(false);
  });
});

describe('offerSlots', () => {
  it('offers the next three free blocks, from the next opening, in order', () => {
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 3,
      now: MON_8AM,
      windowClosesAt: wideWindow,
      full: none,
    });
    expect(iso(slots)).toEqual([
      '2026-11-09T15:00:00.000Z',
      '2026-11-09T15:30:00.000Z',
      '2026-11-09T16:00:00.000Z',
    ]);
    expect(slots.every((s) => s.withinWindow)).toBe(true);
  });

  it('skips a block whose capacity is full', () => {
    const full = new Set([at('2026-11-09T15:30:00.000Z').getTime()]);
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 3,
      now: MON_8AM,
      windowClosesAt: wideWindow,
      full,
    });
    expect(iso(slots)).toEqual([
      '2026-11-09T15:00:00.000Z',
      '2026-11-09T16:00:00.000Z',
      '2026-11-09T16:30:00.000Z',
    ]);
  });

  it('keeps a 10 minute lead: a block that starts sooner is not offered', () => {
    // 09:05 local: the 09:00 block is gone, 09:30 starts in 25 min, 09:10 lead is fine.
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 2,
      now: at('2026-11-09T15:05:00.000Z'),
      windowClosesAt: wideWindow,
      full: none,
    });
    expect(iso(slots)).toEqual([
      '2026-11-09T15:30:00.000Z',
      '2026-11-09T16:00:00.000Z',
    ]);
    // 09:21: the 09:30 block starts in 9 min (< 10), so the first is 10:00.
    const late = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 1,
      now: at('2026-11-09T15:21:00.000Z'),
      windowClosesAt: wideWindow,
      full: none,
    });
    expect(iso(late)).toEqual(['2026-11-09T16:00:00.000Z']);
  });

  it('never offers the last block that would not fit before closing, nor a closed date', () => {
    // Saturday 2026-11-14 18:00 local is the last block (18:00-18:30 .. 18:30-19:00).
    const slots = offerSlots({
      calendar: calendar(['2026-11-16']),
      slotMinutes: 30,
      slotsOffered: 3,
      now: at('2026-11-15T00:30:00.000Z'), // Sat 18:30 local
      windowClosesAt: at('2026-11-20T00:00:00.000Z'),
      full: none,
    });
    // Sat 18:30 start is < 10 min away? now is 18:30 itself, so next is Tuesday
    // (Sunday closed, Monday 16th is a closed date).
    expect(iso(slots)[0]).toBe('2026-11-17T15:00:00.000Z');
  });

  it('offers only within-window blocks when at least one exists (D9)', () => {
    // Window closes at 09:50 local Monday: only the 09:00 and 09:30 blocks have a free greeting? 09:30+15=09:45 < 09:50 yes; 10:00 no.
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 3,
      now: MON_8AM,
      windowClosesAt: at('2026-11-09T15:50:00.000Z'),
      full: none,
    });
    expect(iso(slots)).toEqual([
      '2026-11-09T15:00:00.000Z',
      '2026-11-09T15:30:00.000Z',
    ]);
    expect(slots.every((s) => s.withinWindow)).toBe(true);
  });

  it('falls back to the first blocks flagged withinWindow:false when none is free of charge', () => {
    // Saturday night, window closed long ago: Monday is the next opening.
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 30,
      slotsOffered: 3,
      now: at('2026-11-15T05:00:00.000Z'), // Sat 23:00 local
      windowClosesAt: at('2026-11-15T03:00:00.000Z'),
      full: none,
    });
    expect(iso(slots)).toEqual([
      '2026-11-16T15:00:00.000Z',
      '2026-11-16T15:30:00.000Z',
      '2026-11-16T16:00:00.000Z',
    ]);
    expect(slots.every((s) => !s.withinWindow)).toBe(true);
  });

  it('returns an empty list when nothing is free inside the horizon', () => {
    const every = new Set<number>();
    for (
      let ms = MON_8AM.getTime();
      ms < MON_8AM.getTime() + 20 * 86_400_000;
      ms += 30 * 60_000
    ) {
      every.add(ms);
    }
    expect(
      offerSlots({
        calendar: calendar(),
        slotMinutes: 30,
        slotsOffered: 3,
        now: MON_8AM,
        windowClosesAt: wideWindow,
        full: every,
      }),
    ).toEqual([]);
  });

  it('honors another slot length (15 min) from each opening', () => {
    const slots = offerSlots({
      calendar: calendar(),
      slotMinutes: 15,
      slotsOffered: 2,
      now: MON_8AM,
      windowClosesAt: wideWindow,
      full: none,
    });
    expect(iso(slots)).toEqual([
      '2026-11-09T15:00:00.000Z',
      '2026-11-09T15:15:00.000Z',
    ]);
  });
});

describe('listBookable (staff picker)', () => {
  it('lists up to `limit` free blocks regardless of the window, flagging it', () => {
    const slots = listBookable({
      calendar: calendar(),
      slotMinutes: 30,
      limit: 4,
      now: MON_8AM,
      windowClosesAt: at('2026-11-09T15:50:00.000Z'),
      full: none,
    });
    expect(slots.map((s) => s.withinWindow)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(iso(slots)[3]).toBe('2026-11-09T16:30:00.000Z');
  });
});

describe('isBookableStart', () => {
  const cal = calendar(['2026-11-12']);
  const input = (startsAt: string, now = MON_8AM) => ({
    calendar: cal,
    slotMinutes: 30,
    now,
    startsAt: at(startsAt),
  });
  it('accepts a grid start inside opening hours', () => {
    expect(isBookableStart(input('2026-11-10T15:30:00.000Z'))).toBe(true);
  });
  it('rejects an off-grid instant, an unaligned minute and fractions of a second', () => {
    expect(isBookableStart(input('2026-11-10T15:10:00.000Z'))).toBe(false);
    expect(isBookableStart(input('2026-11-10T15:30:00.500Z'))).toBe(false);
  });
  it('rejects outside the open range, the last partial block, Sunday and a closed date', () => {
    expect(isBookableStart(input('2026-11-10T14:30:00.000Z'))).toBe(false); // 08:30 local
    expect(isBookableStart(input('2026-11-11T01:00:00.000Z'))).toBe(false); // 19:00 local, closed
    expect(isBookableStart(input('2026-11-15T16:00:00.000Z'))).toBe(false); // Sunday
    expect(isBookableStart(input('2026-11-12T16:00:00.000Z'))).toBe(false); // closed date
  });
  it('rejects less than 10 minutes ahead and beyond the 14 day horizon', () => {
    const now = at('2026-11-10T15:25:00.000Z');
    expect(isBookableStart(input('2026-11-10T15:30:00.000Z', now))).toBe(false);
    expect(isBookableStart(input('2026-11-10T16:00:00.000Z', now))).toBe(true);
    expect(isBookableStart(input('2026-11-30T16:00:00.000Z'))).toBe(false);
  });
  it('the horizon is half-open like the offer: exactly now + 14 days is not bookable, the block before is (A2)', () => {
    // 2026-11-23 15:30Z is Monday 09:30 local, a grid start inside the hours.
    const now = at('2026-11-09T15:30:00.000Z');
    const boundary = '2026-11-23T15:30:00.000Z';
    expect(Date.parse(boundary) - now.getTime()).toBe(14 * 86_400_000);
    expect(isBookableStart(input(boundary, now))).toBe(false);
    expect(isBookableStart(input('2026-11-23T15:00:00.000Z', now))).toBe(true);
    // consistent with what is offered: the boundary block is never listed
    const listed = listBookable({
      calendar: cal,
      slotMinutes: 30,
      limit: 10_000,
      now,
      windowClosesAt: at('2027-01-01T00:00:00.000Z'),
      full: new Set(),
    }).map((slot) => slot.startsAt.toISOString());
    expect(listed).not.toContain(boundary);
    expect(listed).toContain('2026-11-23T15:00:00.000Z');
  });
});
