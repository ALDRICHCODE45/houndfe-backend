/**
 * DOMAIN: what the SLA sweep decides for ONE open request (human-intervention
 * unit 7c; contract §5.4, §5.1). Pure: the caller passes the policy, the row's
 * facts, the milestones already recorded for it and `now`.
 *
 * A request has an ACTIVE clock (claim while NEW, else resolve; see
 * `activeClock`) with three milestones: HALF (50 %), ESCALATION (80 %) and
 * OVERDUE (100 %). Their instants are business time (the clock pauses outside
 * hours and on closed dates), so a milestone is never reached "while paused";
 * the one that lands exactly on a close fires at that close.
 *
 * Durable dedup (never twice): a milestone is identified by
 * `clock : milestone : cycle`, where the cycle is the instant the clock
 * started (a release restarts the claim clock, so its milestones repeat in the
 * new cycle; the resolve clock never restarts). The sweep records one
 * SLA_MILESTONE event per key, in the request's own append-only audit, which is
 * kept forever (the notifications that carry the same key are purged at 90
 * days). A key is not planned again even if a policy change moves its instant.
 *
 * After downtime several milestones can be due at once: all are recorded, but
 * only the highest sends a notice (a reminder after the request is overdue is
 * noise).
 */
import type { NoticeType } from '../../notifications/domain/chatbot-request-notice';
import {
  BusinessCalendarError,
  type BusinessCalendar,
} from './business-hours-calendar';
import {
  activeClock,
  type ActiveClock,
  computeSla,
  type SlaAnchors,
  type SlaClockName,
  type SlaColumns,
  type SlaMilestone,
  type SlaPolicy,
} from './chatbot-sla';

export type CustomerNotice = 'SENT' | 'SKIPPED_STALE';

/** Owner decision (L69): an overdue older than this is not told to the customer. */
export const CUSTOMER_NOTICE_MAX_AGE_MS = 24 * 3_600_000;

export interface SweepRow extends SlaAnchors {
  assigneeUserId: string | null;
  slaPolicyVersion: number | null;
}

export interface PlannedMilestone {
  milestone: SlaMilestone;
  /** The instant the milestone was due (not the instant of the sweep). */
  at: Date;
  /** The notice to enqueue; `null` when none is due for this milestone. */
  notice: NoticeType | null;
  /** The assignee is told too (80 % and overdue of a claimed request). */
  withAssignee: boolean;
}

export interface SweepPlan {
  /** The row is on an older policy version: `columns` carry the recompute. */
  stale: boolean;
  columns: SlaColumns | null;
  clock: SlaClockName | null;
  /** Start of the clock's cycle, in ms (the third part of the key). */
  cycle: number | null;
  /** New milestones to record, lowest first. */
  milestones: PlannedMilestone[];
  /** Set when OVERDUE is reached and the request had no `overdueAt` yet. */
  firstOverdueAt: Date | null;
  /**
   * Decided on the first overdue only (`null` otherwise). `SKIPPED_STALE`: the
   * deadline is 24 h or more behind `now` (late sweep, backlog), so telling the
   * customer now would be noise; `overdueAt`, the event and the staff notice
   * still happen.
   */
  customerNotice: CustomerNotice | null;
  nextSlaCheckAt: Date | null;
}

export const milestoneKey = (
  clock: SlaClockName,
  milestone: SlaMilestone,
  cycleStart: Date | number,
): string =>
  `${clock}:${milestone}:${
    typeof cycleStart === 'number' ? cycleStart : cycleStart.getTime()
  }`;

/**
 * §5.1 table. A reminder is "mitad del tiempo SIN TOMAR": only while NEW. The
 * 80 % and overdue notices go to the people with `read:ChatbotEscalation`,
 * and also to the assignee once someone holds the request.
 */
function noticeOf(
  status: SweepRow['status'],
  milestone: SlaMilestone,
): Pick<PlannedMilestone, 'notice' | 'withAssignee'> {
  const withAssignee = status === 'IN_PROGRESS';
  switch (milestone) {
    case 'HALF':
      return {
        notice: status === 'NEW' ? 'REQUEST_CLAIM_REMINDER' : null,
        withAssignee,
      };
    case 'ESCALATION':
      return { notice: 'REQUEST_ESCALATION', withAssignee };
    case 'OVERDUE':
      return { notice: 'REQUEST_OVERDUE', withAssignee };
  }
}

export function planSweep(
  policy: SlaPolicy,
  row: SweepRow,
  done: ReadonlySet<string>,
  now: Date,
): SweepPlan {
  const stale =
    row.slaPolicyVersion === null || row.slaPolicyVersion < policy.version;
  const columns = stale ? computeSla(policy, row, now) : null;
  const empty = {
    stale,
    columns,
    clock: null,
    cycle: null,
    milestones: [],
    firstOverdueAt: null,
    customerNotice: null,
    nextSlaCheckAt: null,
  } satisfies SweepPlan;

  let clock: ActiveClock | null;
  try {
    clock = activeClock(policy, row);
  } catch (error) {
    // No business time inside the horizon: no deadline, nothing to watch.
    if (!(error instanceof BusinessCalendarError)) throw error;
    return empty;
  }
  if (!clock) return empty;

  const cycle = clock.from.getTime();
  const pending = clock.instants.filter(
    ({ milestone }) => !done.has(milestoneKey(clock.clock, milestone, cycle)),
  );
  const reached = pending.filter(({ at }) => at.getTime() <= now.getTime());
  const ahead = pending.find(({ at }) => at.getTime() > now.getTime());
  const milestones = reached.map(
    ({ milestone, at }, index): PlannedMilestone => {
      const highest = index === reached.length - 1;
      const notice = noticeOf(row.status, milestone);
      return {
        milestone,
        at,
        notice: highest ? notice.notice : null,
        withAssignee: notice.withAssignee,
      };
    },
  );
  const overdue = reached.find(({ milestone }) => milestone === 'OVERDUE');
  const firstOverdueAt = overdue && !row.overdueAt ? overdue.at : null;
  return {
    stale,
    columns,
    clock: clock.clock,
    cycle,
    milestones,
    firstOverdueAt,
    customerNotice: firstOverdueAt
      ? now.getTime() - firstOverdueAt.getTime() >= CUSTOMER_NOTICE_MAX_AGE_MS
        ? 'SKIPPED_STALE'
        : 'SENT'
      : null,
    nextSlaCheckAt: ahead?.at ?? null,
  };
}

/** `slaPaused` / `slaResumesAt` of an open request (§5.4, derived on read). */
export function slaPauseAt(
  calendar: BusinessCalendar,
  now: Date,
): { paused: boolean; resumesAt: Date | null } {
  if (calendar.isOpenAt(now)) return { paused: false, resumesAt: null };
  try {
    return { paused: true, resumesAt: calendar.addBusinessMinutes(now, 0) };
  } catch (error) {
    if (!(error instanceof BusinessCalendarError)) throw error;
    return { paused: true, resumesAt: null };
  }
}

/**
 * Staff notices wait for the tenant's next opening (owner decision L69): the
 * milestone is recorded at once, but while the calendar is closed (a late
 * sweep, a deadline exactly on the close, downtime catch-up, a closed date)
 * the notice is released at the next opening. `null` = release now. The
 * instant is stored as the outbox row's `nextAttemptAt`, which the notify
 * consumer already honors (durable, shared by replicas, no timers).
 *
 * A calendar with no next opening inside its horizon (every open weekday
 * closed by `closedDates`) also yields `null`: release immediately. Choice: with
 * nothing to wait for, holding the notice would mean never sending it.
 */
export function noticeReleaseAt(
  calendar: BusinessCalendar,
  now: Date,
): Date | null {
  const { paused, resumesAt } = slaPauseAt(calendar, now);
  return paused ? resumesAt : null;
}
