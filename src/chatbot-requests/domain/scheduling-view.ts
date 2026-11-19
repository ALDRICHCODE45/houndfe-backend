/**
 * DOMAIN: what the bot and staff see of the branch's schedule (unit 14;
 * contract "Scheduled conversations", S20 4, 5) and the pure rules of a
 * reschedule. No clock, no database: `now` is always a parameter.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { AttentionSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import type { BusinessCalendar } from './business-hours-calendar';
import { HORIZON_DAYS, type Slot } from './scheduling';

const MINUTE = 60_000;
const DAY = 86_400_000;
const WINDOW_MS = 24 * 60 * MINUTE;

/** A customer message may not be dated further ahead than this (clock skew). */
export const MAX_FUTURE_MS = 5 * MINUTE;
/** Older than the WhatsApp window and the mirror make any sense for. */
export const MAX_AGE_MS = 30 * DAY;

export interface BusinessHoursView {
  openNow: boolean;
  /** Start of the open range containing now, or of the next one; `null` if none in 14 days. */
  nextOpenAt: string | null;
  timeZone: string;
}

export interface BusinessHoursDetail extends BusinessHoursView {
  weeklyRanges: Array<{
    day: string;
    ranges: Array<{ open: string; close: string }>;
  }>;
  /** Closed dates from today (branch-local) through the next 14 days. */
  closedDates: string[];
}

export function businessHoursView(
  calendar: BusinessCalendar,
  now: Date,
): BusinessHoursView {
  const ranges = calendar.openRangesBetween(
    now,
    new Date(now.getTime() + HORIZON_DAYS * DAY),
  );
  return {
    openNow: calendar.isOpenAt(now),
    nextOpenAt: ranges[0] ? ranges[0][0].toISOString() : null,
    timeZone: calendar.timeZone,
  };
}

/** The branch-local calendar date (`YYYY-MM-DD`) of an instant. */
export function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function businessHoursDetail(
  calendar: BusinessCalendar,
  settings: AttentionSettings,
  now: Date,
): BusinessHoursDetail {
  const from = localDateOf(now, calendar.timeZone);
  const to = localDateOf(
    new Date(now.getTime() + HORIZON_DAYS * DAY),
    calendar.timeZone,
  );
  return {
    ...businessHoursView(calendar, now),
    weeklyRanges: settings.openingHours.days.map((day) => ({
      day: day.day,
      ranges: day.ranges.map((r) => ({ open: r.open, close: r.close })),
    })),
    closedDates: settings.closedDates
      .filter((d) => d >= from && d <= to)
      .sort(),
  };
}

/** `lastCustomerMessageAt + 24 h` (informational; Meta decides at send time). */
export const windowClosesAtOf = (lastCustomerMessageAt: Date): Date =>
  new Date(lastCustomerMessageAt.getTime() + WINDOW_MS);

/** The newest of the instants that are known; `null` when none is. */
export function newestInstant(
  ...values: Array<Date | null | undefined>
): Date | null {
  let newest: Date | null = null;
  for (const value of values) {
    if (value && (!newest || value.getTime() > newest.getTime())) {
      newest = value;
    }
  }
  return newest;
}

export interface SlotView {
  startsAt: string;
  withinWindow: boolean;
  available: true;
}

export const slotViews = (slots: Slot[]): SlotView[] =>
  slots.map((slot) => ({
    startsAt: slot.startsAt.toISOString(),
    withinWindow: slot.withinWindow,
    available: true,
  }));

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

/** An ISO-8601 instant with an explicit zone; anything else is a 400. */
export function parseInstant(value: unknown): Date {
  const date =
    typeof value === 'string' && ISO_WITH_ZONE.test(value)
      ? new Date(value)
      : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new InvalidArgumentError('Invalid instant', 'VALIDATION_ERROR');
  }
  return date;
}

/** `lastCustomerMessageAt` of the slots and reschedule routes (Q5). */
export function parseRecentInstant(value: unknown, now: Date): Date {
  const date = parseInstant(value);
  const skew = date.getTime() - now.getTime();
  if (skew > MAX_FUTURE_MS || -skew > MAX_AGE_MS) {
    throw new InvalidArgumentError('Invalid instant', 'VALIDATION_ERROR');
  }
  return date;
}

export type RescheduleRefusal =
  | 'REQUEST_CLOSED'
  | 'NOT_SCHEDULED'
  | 'RESCHEDULE_NOT_ALLOWED';

export interface ReschedulableState {
  status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
  scheduledFor?: Date | null;
  liveSessionState?: string | null;
}

/**
 * Whether the request may be moved at all (the time and the seat are decided
 * by the caller): open, scheduled, and the live session has not started.
 * `null` means it may.
 */
export function rescheduleRefusal(
  state: ReschedulableState,
): RescheduleRefusal | null {
  if (state.status === 'RESOLVED' || state.status === 'CANCELLED') {
    return 'REQUEST_CLOSED';
  }
  if (!state.scheduledFor) return 'NOT_SCHEDULED';
  const started =
    state.status === 'IN_PROGRESS' ||
    state.liveSessionState === 'STARTING' ||
    state.liveSessionState === 'ACTIVE' ||
    state.liveSessionState === 'ENDING';
  return started ? 'RESCHEDULE_NOT_ALLOWED' : null;
}
