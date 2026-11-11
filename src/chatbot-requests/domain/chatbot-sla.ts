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

function nextCheck(
  policy: SlaPolicy,
  anchors: SlaAnchors,
  clocks: ReturnType<typeof computeClocks>,
  now: Date,
): Date | null {
  const claimActive = anchors.status === 'NEW' && clocks.claimDeadline !== null;
  const deadline = claimActive ? clocks.claimDeadline : clocks.resolveDeadline;
  const from = claimActive ? clocks.claimStart : clocks.start;
  if (!deadline) return null;
  const total = policy.calendar.businessMinutesBetween(from, deadline);
  const instants = [
    ...SLA_MILESTONE_FRACTIONS.map((fraction) =>
      policy.calendar.addBusinessMinutes(from, Math.floor(total * fraction)),
    ),
    deadline,
  ];
  const ahead = instants.find((instant) => instant.getTime() > now.getTime());
  if (ahead) return ahead;
  return anchors.overdueAt ? null : now;
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
      nextSlaCheckAt: nextCheck(policy, anchors, clocks, now),
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
