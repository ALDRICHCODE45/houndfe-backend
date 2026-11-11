/**
 * Pure rules of the staff reads (human-intervention unit 4; contract §3.8,
 * §12.3): the inbox/history windows, opaque cursors and the server-side
 * `allowedActions`. `allowedActions` replays the real state machine
 * (`chatbot-request.commands`) against the current row, so the offer can never
 * disagree with what the command would accept.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  cancelByStaff,
  canMergeSource,
  claim,
  heldByOther,
  linkCustomer,
  reassign,
  release,
  resolve,
  type ChatbotRequestState,
} from './chatbot-request.commands';
import { canResolveSubtype, type PermissionCheck } from './resolve-permissions';

/** D17: closed requests stay in the inbox this long; then they are history. */
export const CLOSED_WINDOW_DAYS = 7;
/** §3.8: `from`/`to` of the history list span at most this many days. */
export const HISTORY_MAX_RANGE_DAYS = 92;

const DAY_MS = 86_400_000;

/** Inbox: `closedAt >= cutoff`. History: `closedAt < cutoff` (disjoint). */
export function closedWindowCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOSED_WINDOW_DAYS * DAY_MS);
}

/**
 * Commands the caller can run right now. `RESCHEDULE` is never offered (the
 * route arrives with unit 14), nor are the reply, message, template and
 * finish actions: their routes do not exist yet.
 */
export type AllowedAction =
  | 'CLAIM'
  | 'RELEASE'
  | 'REASSIGN'
  | 'RESOLVE'
  | 'MERGE'
  | 'LINK_CUSTOMER'
  | 'CANCEL';

export interface AllowedActionsOptions {
  /**
   * The row `resolve` would act on is missing (a zone request without a
   * validation): the route answers 404, so `RESOLVE` is not offered.
   */
  resolveTargetMissing?: boolean;
  /**
   * At least one open request of the same customer and subtype could take this
   * one (§12.11, the `merge-candidates` rule). `MERGE` needs it.
   */
  hasMergeCandidate?: boolean;
  /** The request's customer link; `LINK_CUSTOMER` needs it to be offered. */
  customer?: { customerId: string | null; customerKey: string };
  /**
   * The tenant has at least one customer whose phone is this request's key
   * (the detail's `customer.candidates`). Without one `link-customer` could
   * only answer CUSTOMER_PHONE_MISMATCH, so `LINK_CUSTOMER` is not offered.
   */
  hasLinkCandidate?: boolean;
}

export function computeAllowedActions(
  state: ChatbotRequestState,
  ability: PermissionCheck,
  userId: string,
  options: AllowedActionsOptions = {},
): AllowedAction[] {
  const actor = { userId, displayName: '-' };
  const now = new Date();
  const expectedVersion = state.version;
  const canUpdate = ability.can('update', 'ChatbotRequest');
  const canReassign = ability.can('update', 'ChatbotRequestAssignment');
  const offered: Array<[AllowedAction, boolean]> = [
    ['CLAIM', canUpdate && claim(state, { actor, expectedVersion, now }).ok],
    [
      'RELEASE',
      canUpdate &&
        release(state, {
          actor,
          expectedVersion,
          actorCanReassign: canReassign,
        }).ok,
    ],
    [
      'REASSIGN',
      canReassign &&
        reassign(state, {
          actor,
          expectedVersion,
          toUser: { userId: `${userId}:candidate`, displayName: '-' },
          now,
        }).ok,
    ],
    [
      'RESOLVE',
      canUpdate &&
        !options.resolveTargetMissing &&
        canResolveSubtype(ability, state.subtype) &&
        resolve(state, { actor, expectedVersion, action: 'RESOLVE', now }).ok,
    ],
    [
      'MERGE',
      // Same rule as `cancelByStaff` (M5): someone else's request needs the
      // assignment permission.
      canUpdate &&
        options.hasMergeCandidate === true &&
        canMergeSource(state) &&
        !(heldByOther(state, actor) && !canReassign),
    ],
    [
      'LINK_CUSTOMER',
      canUpdate &&
        options.customer !== undefined &&
        options.hasLinkCandidate === true &&
        linkCustomer(state, {
          actor,
          expectedVersion,
          customerId: 'candidate',
          current: options.customer,
        }).ok,
    ],
    [
      'CANCEL',
      canUpdate &&
        cancelByStaff(state, {
          actor,
          actorCanReassign: canReassign,
          expectedVersion,
          reason: 'DUPLICATE',
          now,
        }).ok,
    ],
  ];
  return offered.filter(([, allowed]) => allowed).map(([action]) => action);
}

/** Opaque cursor: base64url of a JSON array of strings or nulls. */
export function encodeCursor(parts: Array<string | null>): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

/** `date?` may be null (a group with no deadline); the others may not. */
export type CursorKind = 'date' | 'date?' | 'uuid' | 'text';

/** The only form this module writes: `Date#toISOString`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A date PostgreSQL `timestamp` stores (year 1900 to 9999), never Invalid. */
export function isSaneDate(date: Date): boolean {
  const time = date.getTime();
  return (
    !Number.isNaN(time) &&
    date.getUTCFullYear() >= 1900 &&
    date.getUTCFullYear() <= 9999
  );
}

function isValidPart(part: string | null, kind: CursorKind): boolean {
  if (part === null) return kind === 'date?';
  if (kind === 'text') return part.length > 0;
  if (kind === 'uuid') return UUID.test(part);
  const date = new Date(part);
  return (
    ISO_INSTANT.test(part) && isSaneDate(date) && date.toISOString() === part
  );
}

/**
 * Decodes a cursor whose parts have these kinds. A well-formed but bad part
 * (an impossible date, an id that is not a UUID) is a 400, never a database
 * error: the store only ever receives parts it can bind.
 */
export function decodeCursor(
  raw: string,
  kinds: CursorKind[],
): Array<string | null> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    decoded = null;
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== kinds.length ||
    !decoded.every((part) => part === null || typeof part === 'string') ||
    !(decoded as Array<string | null>).every((part, i) =>
      isValidPart(part, kinds[i]),
    )
  ) {
    throw new InvalidArgumentError('Invalid cursor', 'VALIDATION_ERROR');
  }
  return decoded as Array<string | null>;
}
