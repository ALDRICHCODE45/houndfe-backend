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
  claim,
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
 * route arrives with unit 14), nor are the reply, message, template, finish,
 * merge and link-customer actions: their routes do not exist yet.
 */
export type AllowedAction =
  | 'CLAIM'
  | 'RELEASE'
  | 'REASSIGN'
  | 'RESOLVE'
  | 'CANCEL';

export function computeAllowedActions(
  state: ChatbotRequestState,
  ability: PermissionCheck,
  userId: string,
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
        canResolveSubtype(ability, state.subtype) &&
        resolve(state, { actor, expectedVersion, action: 'RESOLVE', now }).ok,
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

export function decodeCursor(raw: string, arity: number): Array<string | null> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    decoded = null;
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== arity ||
    !decoded.every((part) => part === null || typeof part === 'string')
  ) {
    throw new InvalidArgumentError('Invalid cursor', 'VALIDATION_ERROR');
  }
  return decoded as Array<string | null>;
}
