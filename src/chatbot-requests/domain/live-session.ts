/**
 * DOMAIN: the live conversation session (human-intervention unit 11; contract
 * §4.2 to §4.8, §12.10, §12.15). Pure: timings, the ack decision table, what
 * the sweep owes each session, the 24 h window, the staff message text and the
 * mapping from a delivery outcome to the message's `deliveryStatus`.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export type SessionState = 'STARTING' | 'ACTIVE' | 'ENDING' | 'ENDED';
export type SessionEndReason =
  | 'FINISHED'
  | 'FORCED'
  | 'IDLE_TIMEOUT'
  | 'START_TIMEOUT';

/** Subtypes that go live (§4.2): the others never get a session. */
export const LIVE_SUBTYPES = ['TALK_TO_HUMAN', 'COMPLAINT'] as const;
export const isLiveSubtype = (subtype: string): boolean =>
  (LIVE_SUBTYPES as readonly string[]).includes(subtype);

/** §4.2, §4.6, §4.7. These clocks do not pause outside business hours. */
export const SESSION_TIMING = {
  /**
   * No `session-ack STARTED`: the claim reverts (§12.15). This is the DEFAULT
   * (S16 1a: 120 s); the tenant's `startTimeoutSeconds` (30..600) is snapshotted
   * on the session at the claim as `startDeadlineAt`.
   */
  startTimeoutMs: 120_000,
  /** No `session-ack ENDED`: the backend marks it ENDED itself (§4.2). */
  endingTimeoutMs: 10 * 60_000,
  /** The customer silent this long: the session ends by itself (§4.6). */
  idleEndMs: 2 * 3_600_000,
  /** The customer silent this long: "Finalizar" needs no confirmation (§4.6). */
  finishIdleMs: 30 * 60_000,
} as const;

export const WHATSAPP_WINDOW_MS = 24 * 3_600_000;
export const STAFF_MESSAGE_MAX_CHARS = 4096;
export const FINISH_NOTE_MAX_CHARS = 1000;

export interface SessionRecord {
  epoch: number;
  state: SessionState;
  startedAt: Date;
  /** The claim's snapshot of `startedAt + startTimeoutSeconds`; `null`/absent: the default. */
  startDeadlineAt?: Date | null;
  activeAt: Date | null;
  endingAt: Date | null;
}

/** When a STARTING session reverts: its snapshot, else the default timeout. */
export const startDeadline = (
  session: Pick<SessionRecord, 'startedAt' | 'startDeadlineAt'>,
): Date =>
  session.startDeadlineAt ??
  new Date(session.startedAt.getTime() + SESSION_TIMING.startTimeoutMs);

/**
 * The first word of the display name, or `null` when there is no usable name
 * (empty, an email, or the fixed fallback label): the bot then says "una
 * persona del equipo" instead of inventing one (§11 "Textos").
 */
export function staffFirstName(displayName: string | null): string | null {
  const word = displayName?.trim().split(/\s+/)[0] ?? '';
  if (word === '' || word.includes('@') || word === 'Usuario') return null;
  return word;
}

export type AckDecision =
  | 'APPLY'
  | 'REPLAY'
  | 'STALE_EPOCH'
  | 'SESSION_NOT_ENDING';

/**
 * §4.3, §12.15, §4.1. `latest` is the conversation's newest session (highest
 * epoch). The bot may mute (STARTED) a STARTING session of the current epoch
 * and confirm the end (ENDED) of an ENDING one; it can never end a session on
 * its own. A late STARTED after the revert is `STALE_EPOCH`; ENDED for a
 * session that is already over (any reason, any past epoch) is an idempotent
 * replay, so the bot may always send it.
 */
export function decideSessionAck(
  latest: SessionRecord,
  epoch: number,
  state: 'STARTED' | 'ENDED',
): AckDecision {
  if (epoch > latest.epoch) return 'STALE_EPOCH';
  if (state === 'STARTED') {
    if (epoch < latest.epoch) return 'STALE_EPOCH';
    if (latest.state === 'STARTING') return 'APPLY';
    if (latest.state === 'ACTIVE' || latest.state === 'ENDING') return 'REPLAY';
    return 'STALE_EPOCH';
  }
  if (epoch < latest.epoch) return 'REPLAY';
  if (latest.state === 'ENDING') return 'APPLY';
  if (latest.state === 'ENDED') return 'REPLAY';
  return 'SESSION_NOT_ENDING';
}

export type DueAction = 'REVERT_START' | 'MARK_ENDED' | 'IDLE_END';

/**
 * What the sweep owes a session now, or `null`. The idle clock counts from the
 * later of the session's activation and the customer's last message.
 */
export function dueSessionAction(
  session: Pick<
    SessionRecord,
    'state' | 'startedAt' | 'startDeadlineAt' | 'activeAt' | 'endingAt'
  >,
  now: Date,
  lastCustomerMessageAt: Date | null,
): DueAction | null {
  const elapsed = (from: Date) => now.getTime() - from.getTime();
  switch (session.state) {
    case 'STARTING':
      return now.getTime() >= startDeadline(session).getTime()
        ? 'REVERT_START'
        : null;
    case 'ENDING':
      return session.endingAt &&
        elapsed(session.endingAt) >= SESSION_TIMING.endingTimeoutMs
        ? 'MARK_ENDED'
        : null;
    case 'ACTIVE': {
      const since = latest(
        session.activeAt ?? session.startedAt,
        lastCustomerMessageAt,
      );
      return elapsed(since) >= SESSION_TIMING.idleEndMs ? 'IDLE_END' : null;
    }
    case 'ENDED':
      return null;
  }
}

function latest(a: Date, b: Date | null): Date {
  return b && b.getTime() > a.getTime() ? b : a;
}

/** `FINISH_IDLE` (§4.6): the customer has been silent for 30 min. */
export function finishIdle(
  session: Pick<SessionRecord, 'state' | 'startedAt' | 'activeAt'>,
  now: Date,
  lastCustomerMessageAt: Date | null,
): boolean {
  if (session.state !== 'ACTIVE') return false;
  const since = latest(
    session.activeAt ?? session.startedAt,
    lastCustomerMessageAt,
  );
  return now.getTime() - since.getTime() >= SESSION_TIMING.finishIdleMs;
}

/**
 * §4.5: the window closes 24 h after the newest customer message known from
 * either source (the mirror's conversation and the request's own value).
 * `reportedClosedAt` is Meta's own verdict, relayed by a
 * `DEFERRED_WINDOW_CLOSED` outcome: the window closed no later than that
 * instant, unless the customer wrote after it.
 */
export function whatsappWindowClosesAt(
  conversationLast: Date | null,
  requestLast: Date | null,
  reportedClosedAt: Date | null = null,
): Date | null {
  const last = [conversationLast, requestLast]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (!last) return null;
  const closes = new Date(last.getTime() + WHATSAPP_WINDOW_MS);
  if (reportedClosedAt && reportedClosedAt.getTime() > last.getTime()) {
    return reportedClosedAt.getTime() < closes.getTime()
      ? reportedClosedAt
      : closes;
  }
  return closes;
}

export type StaffMessageStatus = 'SENT' | 'UNKNOWN' | 'DEFERRED' | 'FAILED';

/** What the bot's outcome means for a staff message or template (§4.4, §4.7). */
export function messageStatusForOutcome(
  outcome:
    | 'PROVIDER_ACCEPTED'
    | 'DELIVERY_UNKNOWN'
    | 'DEFERRED_WINDOW_CLOSED'
    | 'STALE',
): StaffMessageStatus {
  switch (outcome) {
    case 'PROVIDER_ACCEPTED':
      return 'SENT';
    case 'DELIVERY_UNKNOWN':
      return 'UNKNOWN';
    case 'DEFERRED_WINDOW_CLOSED':
      return 'DEFERRED';
    case 'STALE':
      return 'FAILED';
  }
}

const invalid = (): never => {
  throw new InvalidArgumentError('Invalid request', 'VALIDATION_ERROR');
};

/** Printable text, line breaks and tabs allowed, 1..4096, trimmed. */
function printable(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return invalid();
  const text = raw.trim();
  if (
    text.length === 0 ||
    text.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
  ) {
    return invalid();
  }
  return text;
}

/** The staff message text, as written (§4.4 point 5): never rewritten. */
export const parseStaffMessageText = (raw: unknown): string =>
  printable(raw, STAFF_MESSAGE_MAX_CHARS);

/** The internal closing note (§4.8): 1..1000. */
export const parseFinishNote = (raw: unknown): string =>
  printable(raw, FINISH_NOTE_MAX_CHARS);

export const COMPLAINT_OUTCOMES = [
  'RETURN',
  'REPLACEMENT',
  'REFUND',
  'NO_ACTION',
] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];
