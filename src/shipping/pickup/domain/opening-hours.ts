/**
 * shipping-zones / T7 (S10) — sucursal weekly opening hours.
 *
 * One record per sucursal: an IANA time zone and the seven weekdays, each
 * either closed (no ranges) or one or more `HH:mm` open/close ranges. Ranges
 * of a day must not overlap or touch (`09:00–14:00` + `14:00–18:00` is one
 * range and must be written as such). Ranges never cross midnight; the
 * latest closing time is `23:59`.
 *
 * `formatOpeningHoursEs` builds what the bot shows for store pickup: the
 * structured week plus a short Spanish summary that groups consecutive days
 * with identical hours ("Lunes a viernes: 09:00–14:00 y 16:00–20:00.").
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export const DEFAULT_BUSINESS_TIME_ZONE = 'America/Mexico_City';

export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const LABELS: Record<Weekday, string> = {
  MONDAY: 'Lunes',
  TUESDAY: 'Martes',
  WEDNESDAY: 'Miércoles',
  THURSDAY: 'Jueves',
  FRIDAY: 'Viernes',
  SATURDAY: 'Sábado',
  SUNDAY: 'Domingo',
};

export interface OpeningRange {
  open: string;
  close: string;
}

export interface OpeningDay {
  day: Weekday;
  ranges: OpeningRange[];
}

export interface OpeningHours {
  timeZone: string;
  /** Always the seven weekdays, Monday first; ranges sorted by `open`. */
  days: OpeningDay[];
}

export interface OpeningHoursInput {
  timeZone?: string | null;
  days: Array<{ day: string; ranges: OpeningRange[] }>;
}

export interface FormattedOpeningDay extends OpeningDay {
  label: string;
  closed: boolean;
}

export interface FormattedOpeningHours {
  timeZone: string;
  days: FormattedOpeningDay[];
  summary: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const invalid = (message: string): InvalidArgumentError =>
  new InvalidArgumentError(message, 'INVALID_OPENING_HOURS');

const minutes = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeOpeningHours(input: OpeningHoursInput): OpeningHours {
  const timeZone = input.timeZone?.trim() || DEFAULT_BUSINESS_TIME_ZONE;
  if (!isTimeZone(timeZone)) {
    throw invalid('timeZone is not a valid IANA time zone');
  }
  const byDay = new Map<Weekday, OpeningRange[]>();
  for (const entry of input.days) {
    const day = entry.day as Weekday;
    if (!WEEKDAYS.includes(day)) throw invalid(`Unknown day ${entry.day}`);
    if (byDay.has(day)) throw invalid(`${day} appears more than once`);
    const ranges = entry.ranges.map((range) => {
      if (!TIME.test(range.open) || !TIME.test(range.close)) {
        throw invalid(`${day}: times must be HH:mm between 00:00 and 23:59`);
      }
      if (minutes(range.open) >= minutes(range.close)) {
        throw invalid(`${day}: open must be before close`);
      }
      return { open: range.open, close: range.close };
    });
    ranges.sort((a, b) => minutes(a.open) - minutes(b.open));
    for (let i = 1; i < ranges.length; i++) {
      if (minutes(ranges[i].open) <= minutes(ranges[i - 1].close)) {
        throw invalid(`${day}: ranges must not overlap or touch`);
      }
    }
    byDay.set(day, ranges);
  }
  const missing = WEEKDAYS.filter((day) => !byDay.has(day));
  if (missing.length > 0) {
    throw invalid(`Every weekday is required; missing ${missing.join(', ')}`);
  }
  return {
    timeZone,
    days: WEEKDAYS.map((day) => ({ day, ranges: byDay.get(day)! })),
  };
}

const rangesText = (ranges: OpeningRange[]): string =>
  ranges.length === 0
    ? 'cerrado'
    : ranges
        .map((range) => `${range.open}–${range.close}`)
        .join(', ')
        .replace(/, ([^,]*)$/, ' y $1');

export function formatOpeningHoursEs(
  hours: OpeningHours,
): FormattedOpeningHours {
  const days = hours.days.map((entry) => ({
    day: entry.day,
    label: LABELS[entry.day],
    closed: entry.ranges.length === 0,
    ranges: entry.ranges.map((range) => ({ ...range })),
  }));
  const groups: Array<{ first: number; last: number; text: string }> = [];
  days.forEach((entry, index) => {
    const text = rangesText(entry.ranges);
    const previous = groups[groups.length - 1];
    if (previous && previous.text === text) previous.last = index;
    else groups.push({ first: index, last: index, text });
  });
  const summary = groups
    .map(({ first, last, text }) => {
      const from = days[first].label;
      const to = days[last].label.toLowerCase();
      const name =
        first === last
          ? from
          : last === first + 1
            ? `${from} y ${to}`
            : `${from} a ${to}`;
      return `${name}: ${text}.`;
    })
    .join(' ');
  return { timeZone: hours.timeZone, days, summary };
}
