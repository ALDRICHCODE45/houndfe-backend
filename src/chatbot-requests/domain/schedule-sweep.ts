/**
 * DOMAIN: the schedule sweep's rules (human-intervention unit 14; contract
 * "Scheduled conversations (unit 14)", S20 7 and 8). Pure: no clock, no
 * database; `now` is a parameter.
 *
 * A scheduled request moves through stages, each due at its own instant
 * (`scheduleDueAt`):
 *   0  the reminder, due `REMINDER_LEAD_MINUTES` before `scheduledFor`;
 *   1  the staff "solicitud nueva" notice, due at `scheduledFor`;
 *   2  done (`scheduleDueAt` is NULL, the row leaves the due index).
 * One visit consumes every stage that is due at `now`, so a sweep that was down
 * lands the row in its correct stage in a single step.
 */
import type { BusinessCalendar } from './business-hours-calendar';

const MINUTE = 60_000;

/** S20 7: the reminder is never created with less than this left. */
export const MIN_REMINDER_REMAINING_MINUTES = 3;

export interface SchedulePlanInput {
  /** The stage being visited (0 or 1). */
  stage: number;
  scheduledFor: Date;
  now: Date;
  status: string;
  needsReschedule: boolean;
}

export interface SchedulePlan {
  /** Create `conversation.scheduled_reminder`. */
  reminder: boolean;
  /** Write the staff "solicitud nueva" notice. */
  notice: boolean;
  /** The stage the row ends in. */
  stage: 0 | 1 | 2;
  /** The next due instant; `null` when nothing is left. */
  dueAt: Date | null;
}

const DONE: SchedulePlan = {
  reminder: false,
  notice: false,
  stage: 2,
  dueAt: null,
};

export function planScheduleStep(input: SchedulePlanInput): SchedulePlan {
  // A closed request has nothing left to announce.
  if (input.status !== 'NEW' && input.status !== 'IN_PROGRESS') return DONE;
  // Someone attending it (an early claim) needs neither a reminder nor a
  // "new request" notice.
  const waiting = input.status === 'NEW';
  let stage = input.stage;
  let reminder = false;
  let notice = false;
  if (stage === 0) {
    const remainingMs = input.scheduledFor.getTime() - input.now.getTime();
    // S20 7: never under 3 min before (a late reminder only confuses); S20 8:
    // never while the time is waiting for staff to move it.
    reminder =
      waiting &&
      !input.needsReschedule &&
      remainingMs >= MIN_REMINDER_REMAINING_MINUTES * MINUTE;
    stage = 1;
  }
  if (stage === 1 && input.now.getTime() >= input.scheduledFor.getTime()) {
    notice = waiting;
    stage = 2;
  }
  return {
    reminder,
    notice,
    stage: stage as 0 | 1 | 2,
    dueAt: stage === 1 ? input.scheduledFor : null,
  };
}

/**
 * S19 Q6: a booked time is still valid while its start is inside an open range
 * of the branch's CURRENT hours and not on a closed date. The block grid and
 * the lead and horizon limits are not part of it (Q13: nobody is evicted when
 * `slotMinutes` changes; the 10 min / 14 day limits are about new bookings).
 */
export const isStartStillOpen = (
  calendar: BusinessCalendar,
  startsAt: Date,
): boolean => calendar.isOpenAt(startsAt);

/** Why a booked time needs rescheduling (`needsRescheduleReason`). */
export type NeedsRescheduleReason = 'CLOSED_DATE' | 'HOURS_CHANGED';

/**
 * `null` while the start is still open; otherwise why not: the date is closed
 * (it wins when the hours would also exclude it) or the time is outside the
 * open hours of an open date.
 */
export const needsRescheduleReasonOf = (
  calendar: BusinessCalendar,
  startsAt: Date,
): NeedsRescheduleReason | null => {
  if (isStartStillOpen(calendar, startsAt)) return null;
  return calendar.isClosedDateAt(startsAt) ? 'CLOSED_DATE' : 'HOURS_CHANGED';
};
