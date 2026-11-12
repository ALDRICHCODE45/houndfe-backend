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
  reply,
  resolve,
  type ChatbotRequestState,
  type CommandResult,
} from './chatbot-request.commands';
import {
  canResolveSubtype,
  legacyResolvePermission,
  type PermissionCheck,
} from './resolve-permissions';

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
 * route arrives with unit 14), nor are the message, template and finish
 * actions: their routes do not exist yet. `REPLY` (unit 10) is the clarification
 * answer.
 */
export type AllowedAction =
  | 'CLAIM'
  | 'RELEASE'
  | 'REASSIGN'
  | 'RESOLVE'
  | 'REPLY'
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

/**
 * Why a command the caller would see is not available right now (S8). Only the
 * codes below are ever listed, and only the code: no assignee, no permission
 * name, nothing the row does not already show.
 *
 *   INSUFFICIENT_PERMISSIONS  a permission gate (the route guard, or the legacy
 *                             permission of `resolve`); it always comes first,
 *                             exactly like the command's own check order
 *   REQUEST_CLAIMED_BY_OTHER  `claim` / `resolve` of a request someone holds
 *   NOT_ASSIGNEE              `release` / `cancel` / `merge` of a request
 *                             someone else holds, without the assignment
 *                             permission; `reply` of a clarification that is
 *                             not yours (nobody holds it yet, or someone else
 *                             does): the assignment permission does not lift it
 *   CANCEL_NOT_ALLOWED        a decision is resolved, never cancelled; a
 *                             started live session pins the request
 */
export type DeniedCode =
  | 'INSUFFICIENT_PERMISSIONS'
  | 'REQUEST_CLAIMED_BY_OTHER'
  | 'NOT_ASSIGNEE'
  | 'CANCEL_NOT_ALLOWED';

export interface DeniedAction {
  action: AllowedAction;
  code: DeniedCode;
}

export interface ActionAvailability {
  allowedActions: AllowedAction[];
  deniedActions: DeniedAction[];
}

/** The state-dependent codes worth showing; anything else means "does not apply". */
const INFORMATIVE: readonly string[] = [
  'REQUEST_CLAIMED_BY_OTHER',
  'NOT_ASSIGNEE',
  'CANCEL_NOT_ALLOWED',
];

/**
 * What the command answers for this state, ignoring the permission gates:
 * `'OK'`, `'NOT_APPLICABLE'` or a command error code.
 */
type StateAnswer = string;

const answerOf = (result: CommandResult): StateAnswer =>
  result.ok ? 'OK' : result.error.code;

/**
 * The single evaluation behind `allowedActions` and `deniedActions` (rows and
 * detail). Every action is the real command run against the row's state, plus
 * the permission gates of its route:
 *
 *   - allowed: gates pass and the command would accept;
 *   - denied:  the action applies to the state, but a gate fails
 *              (`INSUFFICIENT_PERMISSIONS`, gates come first, as in the route)
 *              or the command would answer one of the informative codes;
 *   - neither: the action does not apply (release of a NEW request, a closed
 *              row, a stale own re-claim, resolve of a clarification...).
 *
 * `MERGE` and `LINK_CUSTOMER` need facts only the detail loads
 * (`hasMergeCandidate`, `customer`, `hasLinkCandidate`); without them they are
 * in neither list, so a list row never shows them.
 */
export function computeActionAvailability(
  state: ChatbotRequestState,
  ability: PermissionCheck,
  userId: string,
  options: AllowedActionsOptions = {},
): ActionAvailability {
  const actor = { userId, displayName: '-' };
  const now = new Date();
  const expectedVersion = state.version;
  const canUpdate = ability.can('update', 'ChatbotRequest');
  const canReassign = ability.can('update', 'ChatbotRequestAssignment');
  const heldByAnother = heldByOther(state, actor);
  const resolvable = legacyResolvePermission(state.subtype) !== null;

  const evaluated: Array<[AllowedAction, boolean, StateAnswer]> = [
    [
      'CLAIM',
      canUpdate,
      answerOf(claim(state, { actor, expectedVersion, now })),
    ],
    [
      'RELEASE',
      canUpdate,
      answerOf(
        release(state, {
          actor,
          expectedVersion,
          actorCanReassign: canReassign,
        }),
      ),
    ],
    [
      'REASSIGN',
      canReassign,
      answerOf(
        reassign(state, {
          actor,
          expectedVersion,
          toUser: { userId: `${userId}:candidate`, displayName: '-' },
          now,
        }),
      ),
    ],
    [
      'RESOLVE',
      // Route gate, then the subtype's legacy permission (service check).
      canUpdate && canResolveSubtype(ability, state.subtype),
      // No wrapped resolve for the subtype (422) or no zone validation (404):
      // the action does not exist for this row.
      options.resolveTargetMissing || !resolvable
        ? 'NOT_APPLICABLE'
        : answerOf(
            resolve(state, { actor, expectedVersion, action: 'RESOLVE', now }),
          ),
    ],
    [
      'REPLY',
      canUpdate,
      // The real command: only a clarification applies (a decision resolves,
      // a conversation finishes), and only its assignee may answer.
      answerOf(
        reply(state, {
          actor,
          expectedVersion,
          replyId: 'candidate',
          text: 'candidate',
          now,
        }),
      ),
    ],
    [
      'MERGE',
      canUpdate,
      options.hasMergeCandidate !== true || !canMergeSource(state)
        ? 'NOT_APPLICABLE'
        : // Same rule as `cancelByStaff` (M5): someone else's request needs
          // the assignment permission.
          heldByAnother && !canReassign
          ? 'NOT_ASSIGNEE'
          : 'OK',
    ],
    [
      'LINK_CUSTOMER',
      canUpdate,
      options.customer === undefined || options.hasLinkCandidate !== true
        ? 'NOT_APPLICABLE'
        : answerOf(
            linkCustomer(state, {
              actor,
              expectedVersion,
              customerId: 'candidate',
              current: options.customer,
            }),
          ),
    ],
    [
      'CANCEL',
      canUpdate,
      answerOf(
        cancelByStaff(state, {
          actor,
          actorCanReassign: canReassign,
          expectedVersion,
          reason: 'DUPLICATE',
          now,
        }),
      ),
    ],
  ];

  const allowedActions: AllowedAction[] = [];
  const deniedActions: DeniedAction[] = [];
  for (const [action, permitted, answer] of evaluated) {
    if (answer === 'OK' && permitted) {
      allowedActions.push(action);
    } else if (answer === 'OK' || INFORMATIVE.includes(answer)) {
      deniedActions.push({
        action,
        code: permitted ? (answer as DeniedCode) : 'INSUFFICIENT_PERMISSIONS',
      });
    }
  }
  return { allowedActions, deniedActions };
}

/** Commands the caller can run right now (the `allowedActions` of S8's pair). */
export function computeAllowedActions(
  state: ChatbotRequestState,
  ability: PermissionCheck,
  userId: string,
  options: AllowedActionsOptions = {},
): AllowedAction[] {
  return computeActionAvailability(state, ability, userId, options)
    .allowedActions;
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
