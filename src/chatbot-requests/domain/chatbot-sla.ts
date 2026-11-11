/**
 * DOMAIN: SLA deadlines of a chatbot request (human-intervention unit 7a;
 * contract §5.4, §4.9). Pure: the caller passes the policy, the request facts
 * and `now`.
 *
 * Two clocks, both in BUSINESS minutes (they pause outside hours and on closed
 * dates, see `business-hours-calendar`):
 *
 *   claim    "para tomarla": from the clock start; restarts when the request is
 *            released back to NEW (a fresh window for the next person).
 *   resolve  "para resolverla": from the clock start, never restarted. For
 *            TRANSFER_RECEIPT it is the §5.4 receipt rule, not minutes.
 *
 * The clock start is creation, or `scheduledFor` when later (§4.9). Deadlines
 * are stored as absolute instants with the policy version they used.
 *
 * `nextSlaCheckAt` is when the sweep (unit 7c) must look at the request next:
 * the first of the 50 %, 80 % and 100 % instants of the ACTIVE clock (claim
 * while NEW, resolve while IN_PROGRESS; a NEW request with no claim time
 * follows its resolve clock) that is still ahead. When all of them passed and
 * the request is not overdue yet it is `now`, so the sweep marks it at once.
 * The sweep owns the rows after that and moves the column itself.
 *
 * `computeSla` never throws: a calendar with no business time inside its
 * horizon yields no deadlines (creating a request must never fail on settings).
 */
import {
  BusinessCalendarError,
  createBusinessCalendar,
  type BusinessCalendar,
} from './business-hours-calendar';
import type {
  AttentionSettings,
  SettingsSubtype,
} from '../../chatbot-settings/domain/chatbot-attention-settings';

/** Fractions of the active window at which the sweep looks (before 100 %). */
export const SLA_MILESTONE_FRACTIONS = [0.5, 0.8] as const;

/** The three milestones of a clock, in the order they are reached (§5.4). */
export type SlaMilestone = 'HALF' | 'ESCALATION' | 'OVERDUE';
export const SLA_MILESTONES: readonly SlaMilestone[] = [
  'HALF',
  'ESCALATION',
  'OVERDUE',
];
export type SlaClockName = 'CLAIM' | 'RESOLVE';

/** The clock the sweep watches and the instants of its three milestones. */
export interface ActiveClock {
  clock: SlaClockName;
  /** Where the clock started: the identity of one cycle of the claim clock. */
  from: Date;
  deadline: Date;
  instants: ReadonlyArray<{ milestone: SlaMilestone; at: Date }>;
}

export interface SlaPolicy {
  /** `ChatbotAttentionSettings.version`, 0 for a tenant on the defaults. */
  version: number;
  calendar: BusinessCalendar;
  slas: Record<
    SettingsSubtype,
    { claimMinutes: number | null; resolveMinutes: number | null }
  >;
  receiptCloseMarginMinutes: number;
}

export function policyFromSettings(
  settings: AttentionSettings,
  version: number,
): SlaPolicy {
  const slas = {} as SlaPolicy['slas'];
  for (const entry of settings.slas) {
    slas[entry.subtype] = {
      claimMinutes: entry.claimMinutes,
      resolveMinutes: entry.resolveMinutes,
    };
  }
  return {
    version,
    calendar: createBusinessCalendar({
      timeZone: settings.openingHours.timeZone,
      days: settings.openingHours.days,
      closedDates: settings.closedDates,
    }),
    slas,
    receiptCloseMarginMinutes: settings.receiptCloseMarginMinutes,
  };
}

export interface SlaAnchors {
  subtype: SettingsSubtype;
  /** The status the request has AFTER the change being computed. */
  status: 'NEW' | 'IN_PROGRESS';
  createdAt: Date;
  scheduledFor: Date | null;
  /** Last RELEASED / AUTO_RELEASED event, or the release being applied. */
  lastReleasedAt: Date | null;
  overdueAt: Date | null;
}

export interface SlaColumns {
  /** `undefined`: leave the stored value (an in-progress request was claimed). */
  claimDeadlineAt?: Date | null;
  resolveDeadlineAt: Date | null;
  slaPolicyVersion: number;
  nextSlaCheckAt: Date | null;
}

const later = (a: Date, b: Date | null): Date =>
  b && b.getTime() > a.getTime() ? b : a;

function computeClocks(policy: SlaPolicy, anchors: SlaAnchors) {
  const { calendar } = policy;
  const start = later(anchors.createdAt, anchors.scheduledFor);
  const claimStart = later(start, anchors.lastReleasedAt);
  const { claimMinutes, resolveMinutes } = policy.slas[anchors.subtype];
  const claimDeadline =
    claimMinutes === null
      ? null
      : calendar.addBusinessMinutes(claimStart, claimMinutes);
  const resolveDeadline =
    anchors.subtype === 'TRANSFER_RECEIPT'
      ? calendar.receiptDeadline(start, policy.receiptCloseMarginMinutes)
      : resolveMinutes === null
        ? null
        : calendar.addBusinessMinutes(start, resolveMinutes);
  return { start, claimStart, claimDeadline, resolveDeadline };
}

/**
 * The active clock of a request and its milestone instants (§5.4): claim while
 * NEW (when the subtype has claim minutes), else resolve. `null` when that
 * clock has no deadline. May throw `BusinessCalendarError`.
 */
export function activeClock(
  policy: SlaPolicy,
  anchors: SlaAnchors,
): ActiveClock | null {
  const clocks = computeClocks(policy, anchors);
  const claimActive = anchors.status === 'NEW' && clocks.claimDeadline !== null;
  const deadline = claimActive ? clocks.claimDeadline : clocks.resolveDeadline;
  const from = claimActive ? clocks.claimStart : clocks.start;
  if (!deadline) return null;
  const total = policy.calendar.businessMinutesBetween(from, deadline);
  const [half, escalation] = SLA_MILESTONE_FRACTIONS.map((fraction) =>
    policy.calendar.addBusinessMinutes(from, Math.floor(total * fraction)),
  );
  return {
    clock: claimActive ? 'CLAIM' : 'RESOLVE',
    from,
    deadline,
    instants: [
      { milestone: 'HALF', at: half },
      { milestone: 'ESCALATION', at: escalation },
      { milestone: 'OVERDUE', at: deadline },
    ],
  };
}

function nextCheck(
  policy: SlaPolicy,
  anchors: SlaAnchors,
  now: Date,
): Date | null {
  const clock = activeClock(policy, anchors);
  if (!clock) return null;
  const ahead = clock.instants.find(({ at }) => at.getTime() > now.getTime());
  if (ahead) return ahead.at;
  // Every instant passed. `overdueAt` is the first overdue of the REQUEST: when
  // it is at or after this clock's deadline it came from this clock and the
  // sweep has nothing left to do. When it is earlier it came from the claim
  // clock (a request claimed after its resolve deadline), so the resolve
  // clock's milestones were never recorded and the assignee was never told
  // (owner decision): the sweep must visit it once. Milestone keys make that
  // visit idempotent, and the sweep, not this value, sets the next check after.
  return anchors.overdueAt &&
    anchors.overdueAt.getTime() >= clock.deadline.getTime()
    ? null
    : now;
}

export function computeSla(
  policy: SlaPolicy,
  anchors: SlaAnchors,
  now: Date,
): SlaColumns {
  try {
    const clocks = computeClocks(policy, anchors);
    return {
      ...(anchors.status === 'NEW'
        ? { claimDeadlineAt: clocks.claimDeadline }
        : {}),
      resolveDeadlineAt: clocks.resolveDeadline,
      slaPolicyVersion: policy.version,
      nextSlaCheckAt: nextCheck(policy, anchors, now),
    };
  } catch (error) {
    if (!(error instanceof BusinessCalendarError)) throw error;
    return {
      ...(anchors.status === 'NEW' ? { claimDeadlineAt: null } : {}),
      resolveDeadlineAt: null,
      slaPolicyVersion: policy.version,
      nextSlaCheckAt: null,
    };
  }
}
