/**
 * DOMAIN: scheduled conversations (human-intervention unit 14; contract §4.9).
 * Pure: no clock, no database. Every function takes `now` and the tenant's
 * calendar, so the specs drive it with an injected clock.
 *
 * Blocks: `slotMinutes` long, laid out from each opening time of the tenant's
 * business hours, inside the open ranges only (a block that would end after
 * the close is not a block), never on a closed date. A block is identified by
 * its `startsAt` instant (the key of the capacity counter).
 *
 * What is offered (D7, D9; product defaults Q2, Q3 of the bot contract):
 *   - only blocks at least `MIN_LEAD_MINUTES` ahead and within `HORIZON_DAYS`;
 *   - a full block is skipped;
 *   - the next `slotsOffered` free blocks; when at least one free block is
 *     within the free 24 h window only those are offered, otherwise the first
 *     ones flagged `withinWindow: false` (a paid template at the start).
 */
import type { BusinessCalendar } from './business-hours-calendar';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** §4.9.6: the reminder goes about 10 minutes before. */
export const REMINDER_LEAD_MINUTES = 10;
/** §4.9.6: a scheduled conversation can be claimed from 5 minutes before. */
export const CLAIM_LEAD_MINUTES = 5;
/** Q2: a time must be at least this far away (the reminder must not be late). */
export const MIN_LEAD_MINUTES = 10;
/** Q2: and at most this many days ahead. */
export const HORIZON_DAYS = 14;
/** §4.9: the greeting must also fit in the free window: start + 15 min. */
export const GREETING_MARGIN_MINUTES = 15;
/** Q15: the staff picker lists this many blocks. */
export const STAFF_SLOTS_LIMIT = 24;

export interface Slot {
  startsAt: Date;
  /** `startsAt + 15 min < whatsappWindowClosesAt`: the greeting is free. */
  withinWindow: boolean;
}

export const reminderAt = (scheduledFor: Date): Date =>
  new Date(scheduledFor.getTime() - REMINDER_LEAD_MINUTES * MINUTE);

export const claimableAt = (scheduledFor: Date): Date =>
  new Date(scheduledFor.getTime() - CLAIM_LEAD_MINUTES * MINUTE);

export const isWithinWindow = (startsAt: Date, windowClosesAt: Date): boolean =>
  startsAt.getTime() + GREETING_MARGIN_MINUTES * MINUTE <
  windowClosesAt.getTime();

/** Block starts in `[from, to)`, earliest first, each fully inside an open range. */
export function* blockStarts(
  calendar: BusinessCalendar,
  slotMinutes: number,
  from: Date,
  to: Date,
): Generator<Date> {
  const slot = slotMinutes * MINUTE;
  const lowest = from.getTime();
  const highest = to.getTime();
  for (const [open, close] of calendar.openRangesBetween(from, to)) {
    let start = open.getTime();
    if (start < lowest) start += Math.ceil((lowest - start) / slot) * slot;
    for (; start + slot <= close.getTime() && start < highest; start += slot) {
      yield new Date(start);
    }
  }
}

/** The earliest and latest instants a block may start at (Q2). */
const bounds = (now: Date): { from: Date; to: Date } => ({
  from: new Date(now.getTime() + MIN_LEAD_MINUTES * MINUTE),
  to: new Date(now.getTime() + HORIZON_DAYS * DAY),
});

export interface OfferInput {
  calendar: BusinessCalendar;
  slotMinutes: number;
  slotsOffered: number;
  now: Date;
  windowClosesAt: Date;
  /** `startsAt` (epoch ms) of every block with no seat left. */
  full: ReadonlySet<number>;
}

/** The slots the bot shows the customer (see the module comment). */
export function offerSlots(input: OfferInput): Slot[] {
  const { from, to } = bounds(input.now);
  const free: Slot[] = [];
  const paid: Slot[] = [];
  for (const startsAt of blockStarts(
    input.calendar,
    input.slotMinutes,
    from,
    to,
  )) {
    if (input.full.has(startsAt.getTime())) continue;
    if (isWithinWindow(startsAt, input.windowClosesAt)) {
      free.push({ startsAt, withinWindow: true });
      if (free.length >= input.slotsOffered) break;
      continue;
    }
    // The window only shrinks forward in time: nothing later is free either.
    if (free.length > 0) break;
    paid.push({ startsAt, withinWindow: false });
    if (paid.length >= input.slotsOffered) break;
  }
  return free.length > 0 ? free : paid;
}

export interface ListInput {
  calendar: BusinessCalendar;
  slotMinutes: number;
  limit: number;
  now: Date;
  windowClosesAt: Date;
  full: ReadonlySet<number>;
}

/** The staff picker: the next free blocks, window flagged, no preference. */
export function listBookable(input: ListInput): Slot[] {
  const { from, to } = bounds(input.now);
  const slots: Slot[] = [];
  for (const startsAt of blockStarts(
    input.calendar,
    input.slotMinutes,
    from,
    to,
  )) {
    if (input.full.has(startsAt.getTime())) continue;
    slots.push({
      startsAt,
      withinWindow: isWithinWindow(startsAt, input.windowClosesAt),
    });
    if (slots.length >= input.limit) break;
  }
  return slots;
}

export interface BookableInput {
  calendar: BusinessCalendar;
  slotMinutes: number;
  now: Date;
  startsAt: Date;
}

/**
 * `true` when `startsAt` is exactly the start of a block (grid, open hours,
 * not a closed date) at least `MIN_LEAD_MINUTES` ahead and within the
 * horizon. Capacity is a separate check, under the counter's lock.
 */
export function isBookableStart(input: BookableInput): boolean {
  const { from, to } = bounds(input.now);
  const ms = input.startsAt.getTime();
  if (!Number.isFinite(ms) || ms < from.getTime() || ms > to.getTime()) {
    return false;
  }
  const slot = input.slotMinutes * MINUTE;
  const probe = new Date(ms + 1);
  for (const [open, close] of input.calendar.openRangesBetween(
    input.startsAt,
    probe,
  )) {
    if (
      open.getTime() <= ms &&
      ms < close.getTime() &&
      (ms - open.getTime()) % slot === 0 &&
      ms + slot <= close.getTime()
    ) {
      return true;
    }
  }
  return false;
}
