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
  cancelReason?: 'STAFF' | CustomerCancelReason;
  staffCancelReason?: StaffCancelReason;
  closedAt?: Date;
  nextSlaCheckAt?: null;
}

/** Row for the append-only `chatbot_request_events` table (§6.2). */
export interface ChatbotRequestEventDraft {
  type: 'CLAIMED' | 'RELEASED' | 'REASSIGNED' | 'RESOLVED' | 'CANCELLED';
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

const heldByOther = (state: ChatbotRequestState, actor: StaffActor) =>
  state.status === 'IN_PROGRESS' && state.assignee?.userId !== actor.userId;

const userEvent = (actor: StaffActor) => ({
  actorKind: 'USER' as const,
  actorId: actor.userId,
  actorDisplayName: actor.displayName,
});

/** §4.3: a concurrent claimer gets REQUEST_CLAIMED_BY_OTHER, not a bare version conflict. */
export function claim(
  state: ChatbotRequestState,
  cmd: { actor: StaffActor; expectedVersion: number; now: Date },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (heldByOther(state, cmd.actor))
    return reject(state, 'REQUEST_CLAIMED_BY_OTHER', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (state.status !== 'NEW') return reject(state, 'ACTION_NOT_ALLOWED', 422);
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
    canManageAssignments: boolean;
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (state.status !== 'IN_PROGRESS' || !state.assignee) {
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  }
  if (heldByOther(state, cmd.actor) && !cmd.canManageAssignments) {
    return reject(state, 'NOT_ASSIGNEE', 403);
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
  },
): CommandResult {
  if (isClosed(state)) return reject(state, 'REQUEST_CLOSED', 409);
  if (state.kind !== 'DECISION')
    return reject(state, 'ACTION_NOT_ALLOWED', 422);
  if (heldByOther(state, cmd.actor))
    return reject(state, 'REQUEST_CLAIMED_BY_OTHER', 409);
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
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
    },
    { type: 'RESOLVED', ...userEvent(cmd.actor), data: { action: cmd.action } },
  );
}

/**
 * §12.11: wrapped decisions close with their negative action (422); a
 * TALK_TO_HUMAN/COMPLAINT cancels only while its session is WAITING (§12.14,
 * 409 once STARTING/ACTIVE/ENDING). `note` is internal; `customerNote` is what
 * the bot relays.
 */
export function cancelByStaff(
  state: ChatbotRequestState,
  cmd: {
    actor: StaffActor;
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
  if (state.version !== cmd.expectedVersion)
    return reject(state, 'VERSION_CONFLICT', 409);
  if (
    state.kind === 'CONVERSATION' &&
    state.liveSessionState &&
    state.liveSessionState !== 'WAITING'
  ) {
    return reject(state, 'CANCEL_NOT_ALLOWED', 409);
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
