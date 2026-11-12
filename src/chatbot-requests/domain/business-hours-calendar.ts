/**
 * DOMAIN: business-hours calendar of the chatbot inbox (human-intervention
 * unit 7a; contract §5.4, §4.9). Pure: no clock, no database, no framework.
 *
 * It walks the calendar in the tenant's IANA zone over the same weekly
 * `OpeningDay[]` the pickup hours use (`shipping/pickup/domain/opening-hours`),
 * plus `closedDates` (holidays, `YYYY-MM-DD` in the zone). Everything that
 * crosses a day is done on LOCAL calendar dates, and each open or close time
 * is converted to a real instant for that date, so:
 *
 *   - a deadline over a DST weekend lands on the same wall clock the owner
 *     configured (Monday 09:00 is 13:00Z in summer and 14:00Z in winter);
 *   - business minutes are REAL minutes: a range that contains the
 *     spring-forward gap is an hour shorter, one that contains the fall-back
 *     repeat an hour longer;
 *   - a wall time that does not exist (inside the gap) moves forward by the gap
 *     (02:30 becomes 03:30), and a repeated wall time uses its first
 *     occurrence.
 *
 * Ranges never cross midnight (the opening-hours rule), so one local date is
 * an independent set of intervals.
 *
 * Deadlines: `addBusinessMinutes(from, n)` returns the instant at which `n`
 * business minutes have elapsed since `from`. A deadline that falls exactly on
 * a close is that close, not the next opening. `n = 0` returns `from` inside
 * hours, else the next opening. The walk is bounded (`MAX_SCAN_DAYS`), so a
 * calendar closed for years returns an error instead of looping.
 */
import type {
  OpeningDay,
  Weekday,
} from '../../shipping/pickup/domain/opening-hours';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Days the walk scans before giving up (about two years of closed dates). */
export const MAX_SCAN_DAYS = 800;

export class BusinessCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessCalendarError';
  }
}

export interface BusinessCalendarInput {
  /** IANA zone. */
  timeZone: string;
  /** The seven weekdays (any order); ranges are `HH:mm`, within one day. */
  days: readonly OpeningDay[];
  /** Local dates (`YYYY-MM-DD`) with no business time. */
  closedDates: readonly string[];
}

interface LocalDate {
  y: number;
  m: number;
  d: number;
}

type Interval = readonly [startMs: number, endMs: number];

const WEEKDAY_BY_UTC_DAY: Weekday[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall clock of an instant in the zone, as numbers. */
function wallClock(timeZone: string, ms: number) {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Offset of the zone from UTC at an instant, in ms (positive east). */
function offsetAt(timeZone: string, ms: number): number {
  const w = wallClock(timeZone, ms);
  const wallAsUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the zone's wall clock reads `minutes` after midnight of
 * `date`. Ambiguous (fall-back repeat): the first occurrence. Nonexistent
 * (spring-forward gap): shifted forward by the gap.
 */
function localToInstant(
  timeZone: string,
  date: LocalDate,
  minutes: number,
): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d) + minutes * MINUTE;
  const before = offsetAt(timeZone, naive - DAY);
  const after = offsetAt(timeZone, naive + DAY);
  const valid = new Set<number>();
  for (const offset of new Set([before, after])) {
    const candidate = naive - offset;
    if (offsetAt(timeZone, candidate) === offset) valid.add(candidate);
  }
  if (valid.size > 0) return Math.min(...valid);
  return naive - before;
}

const keyOf = ({ y, m, d }: LocalDate): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function nextDate({ y, m, d }: LocalDate): LocalDate {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    y: next.getUTCFullYear(),
    m: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
  };
}

const CLOSED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `true` when `value` is a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  const match = CLOSED_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

const minutesOfDay = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export class BusinessCalendar {
  private readonly rangesByWeekday = new Map<
    Weekday,
    Array<[openMinutes: number, closeMinutes: number]>
  >();
  private readonly closed: ReadonlySet<string>;
  readonly timeZone: string;

  constructor(input: BusinessCalendarInput) {
    try {
      formatterOf(input.timeZone).format(0);
    } catch {
      throw new BusinessCalendarError('timeZone is not a valid IANA zone');
    }
    this.timeZone = input.timeZone;
    let anyRange = false;
    for (const day of input.days) {
      const ranges = day.ranges
        .map(
          (r) =>
            [minutesOfDay(r.open), minutesOfDay(r.close)] as [number, number],
        )
        .filter(([open, close]) => open < close)
        .sort((a, b) => a[0] - b[0]);
      if (ranges.length > 0) anyRange = true;
      this.rangesByWeekday.set(day.day, ranges);
    }
    if (!anyRange) {
      throw new BusinessCalendarError('The week has no open range');
    }
    for (const date of input.closedDates) {
      if (!isCalendarDate(date)) {
        throw new BusinessCalendarError(`Invalid closed date ${date}`);
      }
    }
    this.closed = new Set(input.closedDates);
  }

  /** Local calendar date of an instant in the zone. */
  private localDateOf(ms: number): LocalDate {
    const w = wallClock(this.timeZone, ms);
    return { y: w.year, m: w.month, d: w.day };
  }

  /** The open intervals of one local date, as real instants, sorted. */
  private intervalsOf(date: LocalDate): Interval[] {
    if (this.closed.has(keyOf(date))) return [];
    const weekday =
      WEEKDAY_BY_UTC_DAY[
        new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()
      ];
    const ranges = this.rangesByWeekday.get(weekday) ?? [];
    const result: Interval[] = [];
    for (const [open, close] of ranges) {
      const start = localToInstant(this.timeZone, date, open);
      const end = localToInstant(this.timeZone, date, close);
      if (end > start) result.push([start, end]);
    }
    return result;
  }

  /**
   * The open ranges (whole, not clipped) of every local date that intersects
   * `[from, to)`, as real instants, in order. Unit 14 lays its blocks out from
   * each range's opening.
   */
  openRangesBetween(from: Date, to: Date): Array<[Date, Date]> {
    const start = from.getTime();
    const stop = to.getTime();
    const found: Array<[Date, Date]> = [];
    if (stop <= start) return found;
    let date = this.localDateOf(start);
    for (let scanned = 0; scanned <= MAX_SCAN_DAYS * 5; scanned++) {
      for (const [open, close] of this.intervalsOf(date)) {
        if (close > start && open < stop) {
          found.push([new Date(open), new Date(close)]);
        }
      }
      if (this.dayStartAfter(date) >= stop) break;
      date = nextDate(date);
    }
    return found;
  }

  /** `true` when the instant is inside an open range (the close is outside). */
  isOpenAt(at: Date): boolean {
    const ms = at.getTime();
    return this.intervalsOf(this.localDateOf(ms)).some(
      ([start, end]) => start <= ms && ms < end,
    );
  }

  /** The instant at which `minutes` business minutes have elapsed since `from`. */
  addBusinessMinutes(from: Date, minutes: number): Date {
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new RangeError('minutes must be a finite number >= 0');
    }
    let remaining = minutes * MINUTE;
    const cursor = from.getTime();
    let date = this.localDateOf(cursor);
    for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
      for (const [start, end] of this.intervalsOf(date)) {
        if (end <= cursor) continue;
        const begin = Math.max(start, cursor);
        const room = end - begin;
        if (remaining <= room) return new Date(begin + remaining);
        remaining -= room;
      }
      date = nextDate(date);
    }
    throw new BusinessCalendarError(
      'No business time within the calendar horizon',
    );
  }

  /** Business minutes inside `[from, to)`; 0 when `to` is not after `from`. */
  businessMinutesBetween(from: Date, to: Date): number {
    const start = from.getTime();
    const stop = to.getTime();
    if (stop <= start) return 0;
    let total = 0;
    let date = this.localDateOf(start);
    for (let scanned = 0; scanned <= MAX_SCAN_DAYS * 5; scanned++) {
      for (const [open, close] of this.intervalsOf(date)) {
        if (open >= stop) return total / MINUTE;
        const from_ = Math.max(open, start);
        const to_ = Math.min(close, stop);
        if (to_ > from_) total += to_ - from_;
      }
      if (this.dayStartAfter(date) >= stop) return total / MINUTE;
      date = nextDate(date);
    }
    throw new BusinessCalendarError(
      'Interval longer than the calendar horizon',
    );
  }

  /** First instant of the local day after `date` (a loose upper bound). */
  private dayStartAfter(date: LocalDate): number {
    return localToInstant(this.timeZone, nextDate(date), 0);
  }

  /**
   * §5.4 receipt rule. Arrives inside hours with MORE than `marginMinutes`
   * of business time left that day: due at that day's last close. Anything
   * else (60 minutes or fewer left, after the close, on a closed day or a
   * holiday): due at the last close of the next
   * business day, the first date AFTER the arrival's local date that has hours.
   *
   * The margin counts business minutes left in the day, which for a day with
   * one range is the time to the close. Owner decisions (2026-11-11): arriving
   * before the opening or during a midday break counts the business minutes
   * still ahead that day, so it is due at that day's close when they exceed
   * the margin.
   */
  receiptDeadline(arrival: Date, marginMinutes: number): Date {
    if (!Number.isFinite(marginMinutes) || marginMinutes < 0) {
      throw new RangeError('marginMinutes must be a finite number >= 0');
    }
    const at = arrival.getTime();
    const day = this.localDateOf(at);
    const today = this.intervalsOf(day);
    let left = 0;
    for (const [start, end] of today) {
      if (end > at) left += end - Math.max(start, at);
    }
    if (left > marginMinutes * MINUTE) {
      return new Date(today[today.length - 1][1]);
    }
    let date = nextDate(day);
    for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
      const intervals = this.intervalsOf(date);
      if (intervals.length > 0) {
        return new Date(intervals[intervals.length - 1][1]);
      }
      date = nextDate(date);
    }
    throw new BusinessCalendarError(
      'No business day within the calendar horizon',
    );
  }
}

export function createBusinessCalendar(
  input: BusinessCalendarInput,
): BusinessCalendar {
  return new BusinessCalendar(input);
}
