/**
 * DOMAIN: ChatbotRequest inbox state machine (human-intervention unit 2;
 * contract §2.2, §3.4, §3.8, §6.5, §12.6, §12.11, §12.14).
 *
 * Pure functions: each command takes the locked row state and returns either
 * the column patch plus the audit event to append, or a typed error that maps
 * 1:1 to the contract's HTTP error envelope. The caller runs them inside the
 * `SELECT … FOR UPDATE` transaction (§6.5).
 *
 * R4: claim/release/reassign patch only `chatbot_requests` columns, so a
 * wrapped `HumanDecision.version` (fixed 1 -> 2) is never touched by them.
 */

export type ChatbotRequestKind = 'DECISION' | 'CLARIFICATION' | 'CONVERSATION';
export type ChatbotRequestSubtype =
  | 'RESTOCK'
  | 'EXPIRATION'
  | 'DELIVERY_ZONE'
  | 'TRANSFER_RECEIPT'
  | 'TALK_TO_HUMAN'
  | 'COMPLAINT'
  | 'UNKNOWN_QUESTION'
  | 'DISCOUNT';
export type ChatbotRequestStatus =
  | 'NEW'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'CANCELLED';
export type DisplayStatus = ChatbotRequestStatus | 'EXPIRED';
export type LiveSessionState =
  | 'WAITING'
  | 'STARTING'
  | 'ACTIVE'
  | 'ENDING'
  | 'ENDED'
  | 'CANCELLED';
export type StaffCancelReason =
  | 'DUPLICATE'
  | 'NOT_ACTIONABLE'
  | 'CUSTOMER_UNREACHABLE'
  | 'OTHER';
export type CustomerCancelReason = 'CUSTOMER_WITHDREW' | 'AUTO_RESOLVED';

export interface StaffActor {
  userId: string;
  displayName: string;
}

export interface ChatbotRequestState {
  kind: ChatbotRequestKind;
  subtype: ChatbotRequestSubtype;
  status: ChatbotRequestStatus;
  version: number;
  assignee: StaffActor | null;
  overdueAt: Date | null;
  /** `null` when the request is not a conversation or has no session yet. */
  liveSessionState: LiveSessionState | null;
}

export interface ChatbotRequestPatch {
  status?: ChatbotRequestStatus;
  version: number;
  assigneeUserId?: string | null;
  assigneeDisplayName?: string | null;
  claimedAt?: Date | null;
  resolvedAt?: Date;
  resolvedByActorId?: string;
  resolvedByDisplayName?: string;
  cancelledAt?: Date;
  cancelReason?: 'STAFF' | 'SUPERSEDED' | CustomerCancelReason;
  staffCancelReason?: StaffCancelReason;
  closedAt?: Date;
  nextSlaCheckAt?: null;
  /** Chosen option and its parameters, staff-visible only (§2.1). */
  resolution?: Record<string, unknown>;
  /** `link-customer` (R1): the customer the staff picked. */
  customerId?: string;
  ambiguousCustomer?: boolean;
}

/** Row for the append-only `chatbot_request_events` table (§6.2). */
export interface ChatbotRequestEventDraft {
  type:
    | 'CLAIMED'
    | 'RELEASED'
    | 'REASSIGNED'
    | 'RESOLVED'
    | 'CANCELLED'
    | 'MERGED'
    | 'CUSTOMER_LINKED';
  actorKind: 'USER' | 'SERVICE';
  actorId: string;
  actorDisplayName: string | null;
  fromStatus: ChatbotRequestStatus;
  toStatus: ChatbotRequestStatus;
  version: number;
  data: Record<string, unknown>;
}

export type ChatbotRequestErrorCode =
  | 'VERSION_CONFLICT'
  | 'REQUEST_CLAIMED_BY_OTHER'
  | 'REQUEST_CLOSED'
  | 'ALREADY_RESOLVED'
  | 'NOT_ASSIGNEE'
  | 'ACTION_NOT_ALLOWED'
  | 'CANCEL_NOT_ALLOWED'
  | 'MERGE_NOT_ALLOWED'
  | 'VALIDATION_ERROR';

export interface ChatbotRequestError {
  code: ChatbotRequestErrorCode;
  httpStatus: 400 | 403 | 409 | 422;
  /** §3.8: every 409 carries the current row so the FE catches up. */
  current: {
    version: number;
    status: ChatbotRequestStatus;
    claimedBy: { id: string; displayName: string } | null;
  };
}

export type CommandResult =
  | { ok: true; patch: ChatbotRequestPatch; event: ChatbotRequestEventDraft }
  | { ok: false; error: ChatbotRequestError };

const LIVE_SESSION: readonly LiveSessionState[] = [
  'STARTING',
  'ACTIVE',
  'ENDING',
];

const user = (actor: StaffActor) => ({
  id: actor.userId,
  displayName: actor.displayName,
});

function reject(
  state: ChatbotRequestState,
  code: ChatbotRequestErrorCode,
  httpStatus: ChatbotRequestError['httpStatus'],
): CommandResult {
  return {
    ok: false,
    error: {
      code,
      httpStatus,
      current: {
        version: state.version,
        status: state.status,
        claimedBy: state.assignee ? user(state.assignee) : null,
      },
    },
  };
}

function accept(
  state: ChatbotRequestState,
  patch: Omit<ChatbotRequestPatch, 'version'>,
  event: Pick<
    ChatbotRequestEventDraft,
    'type' | 'actorKind' | 'actorId' | 'actorDisplayName' | 'data'
  >,
): CommandResult {
  const version = state.version + 1;
  return {
    ok: true,
    patch: { ...patch, version },
    event: {
      ...event,
      fromStatus: state.status,
      toStatus: patch.status ?? state.status,
      version,
    },
  };
}

const isClosed = (state: ChatbotRequestState) =>
  state.status === 'RESOLVED' || state.status === 'CANCELLED';

export const heldByOther = (state: ChatbotRequestState, actor: StaffActor) =>
  state.status === 'IN_PROGRESS' && state.assignee?.userId !== actor.userId;

const userEvent = (actor: StaffActor) => ({
  actorKind: 'USER' as const,
  actorId: actor.userId,
  actorDisplayName: actor.displayName,
});

/**
 * §4.3: a concurrent claimer gets REQUEST_CLAIMED_BY_OTHER, not a bare version
 * conflict. Re-claiming your own request (a second tab) is a stale view:
 * VERSION_CONFLICT with `current.claimedBy` lets that tab catch up.
 */
export function claim(
  state: ChatbotRequestState,
  cmd: { actor: StaffActor; expectedVersion: number; now: Date },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (heldByOther(state, cmd.actor))
    return reject(state, 'REQUEST_CLAIMED_BY_OTHER', 409);
  if (state.version !== cmd.expectedVersion || state.status !== 'NEW')
    return reject(state, 'VERSION_CONFLICT', 409);
  return accept(
    state,
    {
      status: 'IN_PROGRESS',
      assigneeUserId: cmd.actor.userId,
      assigneeDisplayName: cmd.actor.displayName,
      claimedAt: cmd.now,
    },
    { type: 'CLAIMED', ...userEvent(cmd.actor), data: {} },
  );
}

/**
 * Releasing someone else's request needs `update:ChatbotRequestAssignment`.
 * A live conversation never goes back to NEW while the bot is muted (§4.2);
 * its return-to-bot path belongs to the live-session unit.
 */
export function release(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    expectedVersion: number;
    actorCanReassign: boolean;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (heldByOther(state, cmd.actor) && !cmd.actorCanReassign) {
    return reject(state, 'NOT_ASSIGNEE', 403);
  }
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (state.status !== 'IN_PROGRESS' || !state.assignee) {
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  }
  if (state.liveSessionState && LIVE_SESSION.includes(state.liveSessionState)) {
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  }
  return accept(
    state,
    {
      status: 'NEW',
      assigneeUserId: null,
      assigneeDisplayName: null,
      claimedAt: null,
    },
    {
      type: 'RELEASED',
      ...userEvent(cmd.actor),
      data: { previousAssignee: user(state.assignee) },
    },
  );
}

/** Caller holds `update:ChatbotRequestAssignment` and validated `toUser` (USER_NOT_ASSIGNABLE). */
export function reassign(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    expectedVersion: number;
    toUser: StaffActor;
    note?: string;
    now: Date;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (
    state.status !== 'IN_PROGRESS' ||
    !state.assignee ||
    state.assignee.userId === cmd.toUser.userId
  ) {
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  }
  return accept(
    state,
    {
      assigneeUserId: cmd.toUser.userId,
      assigneeDisplayName: cmd.toUser.displayName,
      claimedAt: cmd.now,
    },
    {
      type: 'REASSIGNED',
      ...userEvent(cmd.actor),
      data: {
        fromUser: user(state.assignee),
        toUser: user(cmd.toUser),
        ...(cmd.note ? { note: cmd.note } : {}),
      },
    },
  );
}

/** Everything `resolve` and `closeWrapped` write when a decision closes. */
function resolved(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    action: string;
    now: Date;
    resolution?: Record<string, unknown>;
    data?: Record<string, unknown>;
  },
): CommandResult {
  const implicitClaim =
    state.status === 'NEW'
      ? {
          assigneeUserId: cmd.actor.userId,
          assigneeDisplayName: cmd.actor.displayName,
          claimedAt: cmd.now,
        }
      : {};
  return accept(
    state,
    {
      status: 'RESOLVED',
      ...implicitClaim,
      resolvedAt: cmd.now,
      resolvedByActorId: cmd.actor.userId,
      resolvedByDisplayName: cmd.actor.displayName,
      closedAt: cmd.now,
      nextSlaCheckAt: null,
      ...(cmd.resolution ? { resolution: cmd.resolution } : {}),
    },
    {
      type: 'RESOLVED',
      ...userEvent(cmd.actor),
      data: { action: cmd.action, ...cmd.data },
    },
  );
}

/**
 * Only `kind = DECISION` resolves (§12.6). Resolving a NEW request claims it
 * implicitly in the same write (§2.2). The wrapped repository is called by the
 * application with its own expected version (R4).
 */
export function resolve(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    expectedVersion: number;
    action: string;
    now: Date;
    resolution?: Record<string, unknown>;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.kind !== 'DECISION')
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  if (heldByOther(state, cmd.actor))
    return reject(state, 'REQUEST_CLAIMED_BY_OTHER', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  return resolved(state, cmd);
}

/**
 * Closes an open request whose wrapped row was resolved by something other
 * than its own `resolve` command: the legacy staff routes (§2.4) and the
 * sibling requests of a shared zone validation (R9). The wrapped row is the
 * source of truth, so this takes no `expectedVersion` and ignores who holds
 * the request; it only refuses a request that is already closed.
 */
export function closeWrapped(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    action: string;
    now: Date;
    resolution: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  return resolved(state, cmd);
}

/**
 * §12.11: wrapped decisions close with their negative action (422); a
 * TALK_TO_HUMAN/COMPLAINT cancels only while its session is WAITING (§12.14:
 * 409 while STARTING/ACTIVE/ENDING, 422 once ENDED/CANCELLED). Like release,
 * cancelling a request held by someone else needs
 * `update:ChatbotRequestAssignment` (`actorCanReassign`). `note` is internal;
 * `customerNote` is what the bot relays.
 */
export function cancelByStaff(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    actorCanReassign: boolean;
    expectedVersion: number;
    reason: StaffCancelReason;
    note?: string;
    customerNote?: string;
    now: Date;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.kind === 'DECISION')
    return reject(state, 'CANCEL_NOT_ALLOWED', 422);
  if (cmd.reason === 'OTHER' && !cmd.note?.trim()) {
    return reject(state, 'VALIDATION_ERROR', 400);
  }
  if (heldByOther(state, cmd.actor) && !cmd.actorCanReassign) {
    return reject(state, 'NOT_ASSIGNEE', 403);
  }
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (state.liveSessionState && LIVE_SESSION.includes(state.liveSessionState)) {
    return reject(state, 'CANCEL_NOT_ALLOWED', 409);
  }
  if (state.liveSessionState && state.liveSessionState !== 'WAITING') {
    return reject(state, 'CANCEL_NOT_ALLOWED', 422);
  }
  return accept(
    state,
    {
      status: 'CANCELLED',
      cancelledAt: cmd.now,
      cancelReason: 'STAFF',
      staffCancelReason: cmd.reason,
      closedAt: cmd.now,
      nextSlaCheckAt: null,
    },
    {
      type: 'CANCELLED',
      ...userEvent(cmd.actor),
      data: {
        reason: cmd.reason,
        ...(cmd.note ? { note: cmd.note } : {}),
        ...(cmd.customerNote ? { customerNote: cmd.customerNote } : {}),
      },
    },
  );
}

/** §12.11: the subtypes with no wrapped table (the only ones that merge). */
export const MERGEABLE_SUBTYPES: readonly ChatbotRequestSubtype[] = [
  'UNKNOWN_QUESTION',
  'TALK_TO_HUMAN',
  'COMPLAINT',
];

/** A started session (`STARTING`..`ENDED`) pins a request in place (§12.11). */
const sessionStarted = (state: ChatbotRequestState) =>
  state.liveSessionState !== null && state.liveSessionState !== 'WAITING';

/** The merge rules that need only this request: open, mergeable, no session. */
export const canMergeSource = (state: ChatbotRequestState) =>
  !isClosed(state) &&
  MERGEABLE_SUBTYPES.includes(state.subtype) &&
  !sessionStarted(state);

/** One request of a merge: the locked state plus what only the row knows. */
export interface MergeSide {
  id: string;
  folio: number;
  customerKey: string;
  /** `request.merged` tells the bot about ONE conversation: see `merge`. */
  conversationRef: string | null;
  state: ChatbotRequestState;
}

export type MergeResult =
  | {
      ok: true;
      source: { patch: ChatbotRequestPatch; event: ChatbotRequestEventDraft };
      /** The target keeps its version: no patch, only its audit event. */
      target: { event: ChatbotRequestEventDraft };
    }
  | { ok: false; error: ChatbotRequestError; on: 'SOURCE' | 'TARGET' };

/**
 * §12.11: `source` closes as CANCELLED/SUPERSEDED into `target`. Rules: same
 * `customerKey`, same subtype, both open, only subtypes with no wrapped
 * table, no started session. A rule failure is 422 MERGE_NOT_ALLOWED; like
 * every command a closed source is REQUEST_CLOSED and a stale version is
 * VERSION_CONFLICT, each with the `current` of the side that failed (`on`).
 * Check order (the same as `cancelByStaff`, M5): closed, then a source held
 * by someone else without `update:ChatbotRequestAssignment` (403
 * NOT_ASSIGNEE), then the version, then the rules. The holder of the target
 * does not matter. The source's assignee, if someone else, is told by the
 * caller. The target's version does not move (a merge must not fail the CAS of
 * someone about to claim it, like the bot's merge), but its expected version
 * is still checked.
 *
 * Same conversation: both requests need the SAME non-null `conversationRef`,
 * because the `request.merged` feed item names one conversation. A different
 * or missing one is 409 MERGE_NOT_ALLOWED (`on` the target, or the source when
 * it is the one with none).
 */
export function merge(
  source: MergeSide,
  target: MergeSide,
  cmd: {
    actor: StaffActor;
    actorCanReassign: boolean;
    expectedVersion: number;
    intoExpectedVersion: number;
    now: Date;
  },
): MergeResult {
  const fail = (
    side: 'SOURCE' | 'TARGET',
    code: ChatbotRequestErrorCode,
    httpStatus: 403 | 409 | 422,
  ): MergeResult => {
    const failed = reject(
      side === 'SOURCE' ? source.state : target.state,
      code,
      httpStatus,
    );
    if (failed.ok) throw new Error('reject() always fails');
    return { ok: false, error: failed.error, on: side };
  };
  if (isClosed(source.state)) return fail('SOURCE', 'REQUEST_CLOSED', 409);
  if (heldByOther(source.state, cmd.actor) && !cmd.actorCanReassign)
    return fail('SOURCE', 'NOT_ASSIGNEE', 403);
  if (source.state.version !== cmd.expectedVersion)
    return fail('SOURCE', 'VERSION_CONFLICT', 409);
  if (source.id === target.id || !canMergeSource(source.state))
    return fail('SOURCE', 'MERGE_NOT_ALLOWED', 422);
  if (
    target.customerKey !== source.customerKey ||
    target.state.subtype !== source.state.subtype ||
    !canMergeSource(target.state)
  ) {
    return fail('TARGET', 'MERGE_NOT_ALLOWED', 422);
  }
  if (source.conversationRef === null)
    return fail('SOURCE', 'MERGE_NOT_ALLOWED', 409);
  if (target.conversationRef !== source.conversationRef)
    return fail('TARGET', 'MERGE_NOT_ALLOWED', 409);
  if (target.state.version !== cmd.intoExpectedVersion)
    return fail('TARGET', 'VERSION_CONFLICT', 409);
  const closed = accept(
    source.state,
    {
      status: 'CANCELLED',
      cancelledAt: cmd.now,
      cancelReason: 'SUPERSEDED',
      closedAt: cmd.now,
      nextSlaCheckAt: null,
    },
    {
      type: 'MERGED',
      ...userEvent(cmd.actor),
      data: {
        role: 'SOURCE',
        intoRequestId: target.id,
        intoFolio: target.folio,
      },
    },
  );
  if (!closed.ok) return { ok: false, error: closed.error, on: 'SOURCE' };
  return {
    ok: true,
    source: { patch: closed.patch, event: closed.event },
    target: {
      event: {
        type: 'MERGED',
        ...userEvent(cmd.actor),
        fromStatus: target.state.status,
        toStatus: target.state.status,
        version: target.state.version,
        data: {
          role: 'TARGET',
          sourceRequestId: source.id,
          sourceFolio: source.folio,
        },
      },
    },
  };
}

/** `unknown:<id>` keys hold a row id, not a phone: nothing to match (§2.3). */
export const isUnknownKey = (customerKey: string) =>
  customerKey.startsWith('unknown:');

/**
 * R1 (§3.8): the staff links the customer of an ambiguous (or still unlinked)
 * request. Only an open request with no customer and a phone key qualifies;
 * who holds it does not matter. The customer's tenant and phone are checked by
 * the caller against the database (`customerHasKey`).
 */
export function linkCustomer(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
    expectedVersion: number;
    customerId: string;
    current: { customerId: string | null; customerKey: string };
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (cmd.current.customerId !== null || isUnknownKey(cmd.current.customerKey))
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  return accept(
    state,
    { customerId: cmd.customerId, ambiguousCustomer: false },
    {
      type: 'CUSTOMER_LINKED',
      ...userEvent(cmd.actor),
      data: { customerId: cmd.customerId },
    },
  );
}

/**
 * §3.4: the bot carries no version. A RESOLVED request answers
 * ALREADY_RESOLVED so the bot delivers the answer instead; a live conversation
 * is not cancelled here (the customer's words go to the attendant).
 */
export function cancelByCustomer(
  state: ChatbotRequestState,
  cmd: { credentialId: string; reason: CustomerCancelReason; now: Date },
): CommandResult {
  if (state.status === 'RESOLVED')
    return reject(state, 'ALREADY_RESOLVED', 409);
  if (state.status === 'CANCELLED') return reject(state, 'REQUEST_CLOSED', 409);
  if (state.liveSessionState && LIVE_SESSION.includes(state.liveSessionState)) {
    return reject(state, 'CANCEL_NOT_ALLOWED', 409);
  }
  return accept(
    state,
    {
      status: 'CANCELLED',
      cancelledAt: cmd.now,
      cancelReason: cmd.reason,
      closedAt: cmd.now,
      nextSlaCheckAt: null,
    },
    {
      type: 'CANCELLED',
      actorKind: 'SERVICE',
      actorId: cmd.credentialId,
      actorDisplayName: null,
      data: { reason: cmd.reason },
    },
  );
}

/** §2.2: overdue is a mark, not a state; EXPIRED = open with `overdueAt`. */
export function displayStatus(state: ChatbotRequestState): DisplayStatus {
  return !isClosed(state) && state.overdueAt ? 'EXPIRED' : state.status;
}
