/**
 * APPLICATION: staff commands on a chatbot request (human-intervention unit 2;
 * contract §3.8, §6.5, §12.11, §12.12, §12.14).
 *
 * Every command runs in ONE transaction, in this order:
 *   1. advisory lock on `(tenant, actor, Idempotency-Key)`, then the receipt:
 *      same hash -> stored response (even if the version moved on), other
 *      hash -> 409 IDEMPOTENCY_CONFLICT;
 *   2. `SELECT … FOR UPDATE` on the tenant's request row (404 otherwise);
 *   3. the pure state machine decides;
 *   4. the store applies the CAS patch, appends the event and refreshes the
 *      customer group (lock order: request row, then group row);
 *   5. the receipt stores the response.
 * A rejected command throws, so it rolls back and stores no receipt: a retry
 * is evaluated again against the current row.
 *
 * `resolve` (unit 3) follows the lock-order rules of
 * docs/chatbot-requests-model.md: for a zone the postal-code lock comes first
 * (the legacy zone resolve takes it first too), then the request rows (own row,
 * then the siblings in id order), then the wrapped repository, then the groups
 * in sorted `customerKey` order.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  cancelByStaff,
  claim,
  closeWrapped,
  displayStatus,
  finish,
  reassign,
  release,
  reply,
  resolve,
  type ChatbotRequestError,
  type ChatbotRequestEventDraft,
  type ChatbotRequestKind,
  type ChatbotRequestPatch,
  type ChatbotRequestState,
  type ChatbotRequestStatus,
  type ChatbotRequestSubtype,
  type CommandResult,
  type DisplayStatus,
  type LiveSessionState,
  type StaffActor,
  type StaffCancelReason,
} from '../domain/chatbot-request.commands';
import { isLiveSubtype } from '../domain/live-session';
import { legacyResolvePermission } from '../domain/resolve-permissions';

export const CHATBOT_REQUEST_COMMAND_STORE = Symbol(
  'CHATBOT_REQUEST_COMMAND_STORE',
);
export const CHATBOT_REQUEST_RESOLVER = Symbol('CHATBOT_REQUEST_RESOLVER');

/**
 * The `resolve.action` union per subtype (§12.6). Each variant is exactly what
 * the existing parsers accept, minus `resolutionRequestId` (derived from the
 * Idempotency-Key) and with `expectedVersion` moved to the command.
 */
export type ResolveAction =
  | { type: 'PROVIDE_RESTOCK_ESTIMATE'; restockDays: number }
  | { type: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' }
  | { type: 'PROVIDE_EXPIRATION_TEXT'; expirationText: string }
  | { type: 'REPORT_EXPIRATION_UNAVAILABLE' }
  | {
      type: 'APPROVE_DELIVERY_ZONE';
      settings: {
        type: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY';
        surchargeCents: number | null;
        etaDays: number | null;
      };
      expectedZoneSetVersion: number;
    }
  | { type: 'REJECT_DELIVERY_ZONE'; expectedZoneSetVersion: number }
  | { type: 'CONFIRM_RECEIPT'; amountCents: number }
  | { type: 'REJECT_RECEIPT'; reason: string; customerReason: string };

const ACTION_SUBTYPE: Record<ResolveAction['type'], ChatbotRequestSubtype> = {
  PROVIDE_RESTOCK_ESTIMATE: 'RESTOCK',
  REPORT_RESTOCK_ESTIMATE_UNAVAILABLE: 'RESTOCK',
  PROVIDE_EXPIRATION_TEXT: 'EXPIRATION',
  REPORT_EXPIRATION_UNAVAILABLE: 'EXPIRATION',
  APPROVE_DELIVERY_ZONE: 'DELIVERY_ZONE',
  REJECT_DELIVERY_ZONE: 'DELIVERY_ZONE',
  CONFIRM_RECEIPT: 'TRANSFER_RECEIPT',
  REJECT_RECEIPT: 'TRANSFER_RECEIPT',
};

/** Staff-visible `resolution` column: the option and its parameters (§2.1). */
function toResolution(action: ResolveAction): Record<string, unknown> {
  switch (action.type) {
    case 'APPROVE_DELIVERY_ZONE':
      return {
        action: action.type,
        zoneType: action.settings.type,
        surchargeCents: action.settings.surchargeCents,
        etaDays: action.settings.etaDays,
      };
    case 'REJECT_DELIVERY_ZONE':
      return { action: action.type };
    default: {
      const { type, ...fields } = action;
      return { action: type, ...fields };
    }
  }
}

export interface ZoneImpactView {
  validationId: string;
  requests: number;
  customers: number;
  setVersion: number;
}

export interface WrappedResolveInput {
  row: ChatbotRequestRow;
  action: ResolveAction;
  actor: StaffActor;
  actorIsSuperAdmin: boolean;
  /** The staff Idempotency-Key; the wrapped use cases take it as their own. */
  resolutionKey: string;
}

/**
 * Port to the existing resolve use cases (R4: each runs with its own
 * `expectedVersion = 1`). It joins the caller's READ COMMITTED transaction and
 * leaves closing the common requests to the application.
 */
export interface ChatbotRequestResolver {
  resolve(input: WrappedResolveInput): Promise<void>;
}

export type StaffCommand =
  | { kind: 'claim' }
  | { kind: 'release' }
  | { kind: 'reassign'; toUserId: string; note?: string }
  | {
      kind: 'cancel';
      reason: StaffCancelReason;
      note?: string;
      customerNote?: string;
    }
  | { kind: 'resolve'; action: ResolveAction }
  /** Unit 10: `text` is already cleaned by `parseReplyText`. */
  | { kind: 'reply'; text: string }
  /** Unit 11 (§4.8): `note` is already cleaned by `parseFinishNote`. */
  | { kind: 'finish'; note: string; complaintOutcome?: string };

export interface StaffCommandInput {
  requestId: string;
  actorUserId: string;
  /** `update:ChatbotRequestAssignment`, from the caller's CASL ability. */
  actorCanReassign: boolean;
  /** JWT `isSuperAdmin`; the wrapped resolve use cases skip membership for it. */
  actorIsSuperAdmin?: boolean;
  /**
   * `resolve` only: whether the caller's ability holds the legacy permission
   * of that subtype (`canResolveSubtype`). Missing means denied.
   */
  actorCanResolveSubtype?: (subtype: ChatbotRequestSubtype) => boolean;
  idempotencyKey: string;
  expectedVersion: number;
  command: StaffCommand;
}

/** The locked `chatbot_requests` columns a command reads. */
export interface ChatbotRequestRow {
  id: string;
  folio: number;
  kind: ChatbotRequestKind;
  subtype: ChatbotRequestSubtype;
  status: ChatbotRequestStatus;
  version: number;
  customerKey: string;
  conversationRef: string | null;
  assigneeUserId: string | null;
  assigneeDisplayName: string | null;
  claimedAt: Date | null;
  overdueAt: Date | null;
  closedAt: Date | null;
  humanDecisionId: string | null;
  deliveryZoneRequestId: string | null;
  receiptEvidenceId: string | null;
  /** Unit 11: the derived session state (§12.4); absent when not loaded. */
  liveSessionState?: LiveSessionState | null;
}

/** `200 {request}` body; unit 4 extends it to the full inbox row (§3.8). */
export interface ChatbotRequestView {
  id: string;
  folio: string;
  kind: ChatbotRequestKind;
  subtype: ChatbotRequestSubtype;
  status: ChatbotRequestStatus;
  displayStatus: DisplayStatus;
  version: number;
  assignee: { id: string; displayName: string } | null;
  claimedAt: string | null;
  overdueAt: string | null;
  closedAt: string | null;
}

/** A window-deferred staff message that became terminal FAILED (S16 3). */
export interface FailedStaffMessage {
  messageId: string;
  seq: number;
}

export interface ChatbotRequestCommandStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  lockIdempotencyKey(actorId: string, key: string): Promise<void>;
  findReceipt(
    actorId: string,
    key: string,
  ): Promise<{ commandHash: string; responseSnapshot: unknown } | null>;
  saveReceipt(
    actorId: string,
    key: string,
    commandHash: string,
    response: ChatbotRequestView,
  ): Promise<void>;
  findActor(userId: string): Promise<StaffActor | null>;
  /** Active tenant member holding `update:ChatbotRequest` (§6.1). */
  findAssignableUser(userId: string): Promise<StaffActor | null>;
  lockRequest(id: string): Promise<ChatbotRequestRow | null>;
  /** CAS update, event insert and customer-group refresh. */
  apply(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void>;
  /** `resolve` only: the CAS and the event, without the group refresh. */
  applyPatch(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void>;
  refreshGroups(customerKeys: string[]): Promise<void>;
  /**
   * Feed items (unit 5b), on this transaction and before the group refresh:
   * `request.answered` for each resolved wrapped request (call it after the
   * wrapped row was written), `request.cancelled` for a staff cancellation.
   */
  enqueueAnswered(requestIds: string[]): Promise<void>;
  enqueueCancelled(
    requestId: string,
    reason: StaffCancelReason,
    customerNote?: string,
  ): Promise<void>;
  /** `request.answered` of a staff clarification reply (unit 10). */
  enqueueClarificationAnswer(
    requestId: string,
    replyId: string,
    text: string,
  ): Promise<void>;
  /**
   * Unit 11 (§4.3): the claim of a live request starts epoch N+1, a STARTING
   * session and `conversation.started`, on this transaction, after the claim
   * patch and before the group refresh (feed rule 6).
   */
  startLiveSession(row: ChatbotRequestRow, actor: StaffActor): Promise<void>;
  /**
   * Unit 11 (S15 Q2): reassign of a live request: the patch, the unit 6 notice
   * and `conversation.reassigned` for a STARTING/ACTIVE session (same epoch),
   * without the group refresh.
   */
  reassignLiveSession(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
    toUser: StaffActor,
  ): Promise<void>;
  /** Unit 11 (§4.8): ACTIVE -> ENDING and `conversation.ended` after a finish. */
  beginLiveSessionEnding(
    row: ChatbotRequestRow,
    reason: 'FINISHED' | 'FORCED',
  ): Promise<FailedStaffMessage[]>;
  /** The LAST write of the transaction: `session.*` with the row (§12.8). */
  emitSessionEvent(
    requestId: string,
    type: 'session.starting' | 'session.ending',
    version: number,
    failedMessages?: FailedStaffMessage[],
  ): Promise<void>;
  /**
   * Takes the postal-code lock of a DELIVERY_ZONE request (a no-op for any
   * other id). It must run before `lockRequest`: the legacy zone resolve and
   * the bot intake take that lock first.
   */
  lockZoneOf(requestId: string): Promise<void>;
  /** Locks the open sibling requests of the zone (id order) and counts them. */
  lockZoneSet(row: ChatbotRequestRow): Promise<{
    siblings: ChatbotRequestRow[];
    impact: ZoneImpactView;
  } | null>;
  /** Unlocked read for `GET :id/zone-impact`; `null` when not a zone request. */
  readZoneImpact(requestId: string): Promise<{
    found: boolean;
    impact: ZoneImpactView | null;
  }>;
}

export type ChatbotRequestCommandErrorCode =
  | ChatbotRequestError['code']
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'USER_NOT_ASSIGNABLE'
  | 'CUSTOMER_PHONE_MISMATCH'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'ZONE_SET_CHANGED'
  // Bot intake (unit 5).
  | 'CUSTOMER_OPEN_LIMIT'
  | 'CUSTOMER_RATE_LIMITED'
  | 'SUBTYPE_DISABLED'
  | 'SCHEDULING_DISABLED'
  // Bot feed (unit 5, slice 5b).
  | 'RATE_LIMITED'
  | 'CURSOR_EXPIRED'
  | 'OUTCOME_ALREADY_RECORDED'
  | 'OUTCOME_NOT_ALLOWED'
  // Staff reads (unit 4).
  | 'RANGE_TOO_LARGE'
  // Conversation mirror and media (unit 9).
  | 'BATCH_TOO_LARGE'
  | 'MESSAGE_ID_CONFLICT'
  | 'REPLY_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_TYPE_MISMATCH'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_TYPE_NOT_ALLOWED'
  | 'MEDIA_PURGED'
  | 'THUMB_UNAVAILABLE'
  | 'MEDIA_STORAGE_FAILED'
  // Live conversation (unit 11).
  | 'STALE_EPOCH'
  | 'SESSION_NOT_ENDING'
  | 'WINDOW_CLOSED'
  | 'TEMPLATE_ALREADY_SENT'
  | 'TEMPLATE_NOT_CONFIGURED';

/** §3.8: `ZONE_SET_CHANGED` also carries the new `zoneImpact`. */
export type ChatbotRequestCommandCurrent = ChatbotRequestError['current'] & {
  zoneImpact?: ZoneImpactView;
};

export class ChatbotRequestCommandError extends Error {
  /**
   * `extra` is merged into the error body: small, fixed-shape facts the bot
   * needs (`{limit, open}`, the `resolution` of an ALREADY_RESOLVED request);
   * `retryAfterSeconds` becomes the `Retry-After` header instead.
   */
  constructor(
    readonly code: ChatbotRequestCommandErrorCode,
    readonly httpStatus:
      | 400
      | 401
      | 403
      | 404
      | 409
      | 410
      | 413
      | 415
      | 422
      | 429
      | 503,
    readonly current?: ChatbotRequestCommandCurrent,
    readonly extra?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'ChatbotRequestCommandError';
  }
}

export const formatFolio = (folio: number) =>
  `S-${String(folio).padStart(6, '0')}`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toState(
  row: Pick<
    ChatbotRequestRow,
    | 'kind'
    | 'subtype'
    | 'status'
    | 'version'
    | 'assigneeUserId'
    | 'assigneeDisplayName'
    | 'overdueAt'
  > & { liveSessionState?: LiveSessionState | null },
): ChatbotRequestState {
  return {
    kind: row.kind,
    subtype: row.subtype,
    status: row.status,
    version: row.version,
    assignee:
      row.assigneeUserId && row.assigneeDisplayName
        ? { userId: row.assigneeUserId, displayName: row.assigneeDisplayName }
        : null,
    overdueAt: row.overdueAt,
    liveSessionState: row.liveSessionState ?? null,
  };
}

function toView(row: ChatbotRequestRow): ChatbotRequestView {
  const state = toState(row);
  return {
    id: row.id,
    folio: formatFolio(row.folio),
    kind: row.kind,
    subtype: row.subtype,
    status: row.status,
    displayStatus: displayStatus(state),
    version: row.version,
    assignee: state.assignee
      ? { id: state.assignee.userId, displayName: state.assignee.displayName }
      : null,
    claimedAt: iso(row.claimedAt),
    overdueAt: iso(row.overdueAt),
    closedAt: iso(row.closedAt),
  };
}

const rejected = (error: ChatbotRequestError) =>
  new ChatbotRequestCommandError(error.code, error.httpStatus, error.current);

function commandHash(input: StaffCommandInput): string {
  const command = input.command as Record<string, unknown>;
  const fields = Object.keys(command)
    .filter((key) => command[key] !== undefined)
    .sort()
    .map((key) => [key, command[key]]);
  return createHash('sha256')
    .update(
      JSON.stringify([input.requestId, input.expectedVersion, fields]),
      'utf8',
    )
    .digest('hex');
}

/**
 * One transaction per staff command (§6.5, §12.12): the advisory lock on the
 * Idempotency-Key, then the receipt (same hash replays the stored response,
 * another hash is 409), then `work`, whose response is stored as the receipt.
 * A throw rolls everything back and stores no receipt. Shared by every staff
 * command service.
 */
export function withStaffReceipt(
  store: Pick<
    ChatbotRequestCommandStore,
    'transaction' | 'lockIdempotencyKey' | 'findReceipt' | 'saveReceipt'
  >,
  actorId: string,
  key: string,
  hash: string,
  work: () => Promise<ChatbotRequestView>,
): Promise<ChatbotRequestView> {
  return store.transaction(async () => {
    await store.lockIdempotencyKey(actorId, key);
    const receipt = await store.findReceipt(actorId, key);
    if (receipt) {
      if (receipt.commandHash !== hash) {
        throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
      }
      return receipt.responseSnapshot as ChatbotRequestView;
    }
    const response = await work();
    await store.saveReceipt(actorId, key, hash, response);
    return response;
  });
}

export const toRequestView = toView;

@Injectable()
export class ChatbotRequestCommandsService {
  constructor(
    @Inject(CHATBOT_REQUEST_COMMAND_STORE)
    private readonly store: ChatbotRequestCommandStore,
    @Inject(CHATBOT_REQUEST_RESOLVER)
    private readonly resolver: ChatbotRequestResolver,
  ) {}

  execute(input: StaffCommandInput): Promise<ChatbotRequestView> {
    const hash = commandHash(input);
    const { actorUserId: actorId, idempotencyKey: key } = input;
    return withStaffReceipt(this.store, actorId, key, hash, async () => {
      const actor = await this.store.findActor(actorId);
      if (!actor) throw new ChatbotRequestCommandError('UNAUTHORIZED', 401);
      const toUser =
        input.command.kind === 'reassign'
          ? await this.store.findAssignableUser(input.command.toUserId)
          : null;
      if (input.command.kind === 'reassign' && !toUser) {
        throw new ChatbotRequestCommandError('USER_NOT_ASSIGNABLE', 422);
      }

      const resolving =
        input.command.kind === 'resolve' ? input.command.action : null;
      if (resolving) await this.store.lockZoneOf(input.requestId);
      const row = await this.store.lockRequest(input.requestId);
      if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      // Only wrapped decisions resolve (§12.6): not clarifications, not
      // conversations, and not DISCOUNT (a decision with no wrapped flow). That
      // is a property of the subtype, not of the request's state, so it answers
      // 422 before the permission gate, which applies to the wrapped subtypes.
      if (
        resolving &&
        (row.kind !== 'DECISION' ||
          legacyResolvePermission(row.subtype) === null)
      ) {
        throw new ChatbotRequestCommandError('ACTION_NOT_ALLOWED', 422, {
          version: row.version,
          status: row.status,
          claimedBy: toView(row).assignee,
        });
      }
      // Before any state-dependent answer, so a caller who may not resolve
      // this subtype learns nothing beyond what `read` already shows. No
      // `current`: the 403 carries no request state.
      if (resolving && !input.actorCanResolveSubtype?.(row.subtype)) {
        throw new ChatbotRequestCommandError('INSUFFICIENT_PERMISSIONS', 403);
      }
      const result = this.decide(toState(row), input, actor, toUser);
      if (!result.ok) throw rejected(result.error);

      if (resolving) {
        await this.resolveWrapped(row, result, input, actor, resolving);
      } else if (input.command.kind === 'cancel') {
        // The staff cancellation notice joins the same transaction (§12.14),
        // after the state change and before the group refresh.
        await this.store.applyPatch(row, result.patch, result.event);
        await this.store.enqueueCancelled(
          row.id,
          input.command.reason,
          input.command.customerNote,
        );
        await this.store.refreshGroups([row.customerKey]);
      } else if (
        input.command.kind === 'claim' &&
        row.kind === 'CONVERSATION' &&
        row.conversationRef !== null &&
        isLiveSubtype(row.subtype)
      ) {
        // Unit 11: the claim of a live request starts the session (§4.3).
        await this.store.applyPatch(row, result.patch, result.event);
        await this.store.startLiveSession(row, actor);
        await this.store.refreshGroups([row.customerKey]);
        await this.store.emitSessionEvent(
          row.id,
          'session.starting',
          result.patch.version,
        );
      } else if (
        input.command.kind === 'reassign' &&
        row.kind === 'CONVERSATION' &&
        row.conversationRef !== null &&
        isLiveSubtype(row.subtype)
      ) {
        // Unit 11 (S15 Q2): the bot tells the customer who attends now.
        await this.store.reassignLiveSession(
          row,
          result.patch,
          result.event,
          toUser as StaffActor,
        );
        await this.store.refreshGroups([row.customerKey]);
      } else if (input.command.kind === 'finish') {
        await this.store.applyPatch(row, result.patch, result.event);
        const failed = await this.store.beginLiveSessionEnding(
          row,
          result.event.data.forced === true ? 'FORCED' : 'FINISHED',
        );
        await this.store.refreshGroups([row.customerKey]);
        await this.store.emitSessionEvent(
          row.id,
          'session.ending',
          result.patch.version,
          failed,
        );
      } else if (input.command.kind === 'reply') {
        // Unit 10: the answer for the bot joins the same transaction, after
        // the state change and before the group refresh (feed rule 6).
        await this.store.applyPatch(row, result.patch, result.event);
        await this.store.enqueueClarificationAnswer(
          row.id,
          result.event.data.messageId as string,
          input.command.text,
        );
        await this.store.refreshGroups([row.customerKey]);
      } else {
        await this.store.apply(row, result.patch, result.event);
      }
      return toView({ ...row, ...result.patch } as ChatbotRequestRow);
    });
  }

  /**
   * Resolve (unit 3). The request and its siblings are closed first, then the
   * wrapped use case runs with its own `expectedVersion = 1` (R4), then the
   * groups refresh last. Any failure throws, which rolls everything back.
   */
  private async resolveWrapped(
    row: ChatbotRequestRow,
    result: Extract<CommandResult, { ok: true }>,
    input: StaffCommandInput,
    actor: StaffActor,
    action: ResolveAction,
  ): Promise<void> {
    const current = () => ({
      version: row.version,
      status: row.status,
      claimedBy: toView(row).assignee,
    });
    if (ACTION_SUBTYPE[action.type] !== row.subtype) {
      throw new ChatbotRequestCommandError(
        'ACTION_NOT_ALLOWED',
        422,
        current(),
      );
    }

    let siblings: ChatbotRequestRow[] = [];
    if (
      action.type === 'APPROVE_DELIVERY_ZONE' ||
      action.type === 'REJECT_DELIVERY_ZONE'
    ) {
      const zone = await this.store.lockZoneSet(row);
      if (!zone) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      if (zone.impact.setVersion !== action.expectedZoneSetVersion) {
        throw new ChatbotRequestCommandError('ZONE_SET_CHANGED', 409, {
          ...current(),
          zoneImpact: zone.impact,
        });
      }
      siblings = zone.siblings.filter((sibling) => sibling.id !== row.id);
    }

    await this.store.applyPatch(row, result.patch, result.event);
    const now = new Date();
    for (const sibling of siblings) {
      const closed = closeWrapped(toState(sibling), {
        actor,
        action: 'SIBLING_RESOLVED',
        now,
        resolution: { action: 'SIBLING_RESOLVED', viaRequestId: row.id },
        data: { viaRequestId: row.id },
      });
      if (!closed.ok) throw rejected(closed.error);
      await this.store.applyPatch(sibling, closed.patch, closed.event);
    }

    try {
      await this.resolver.resolve({
        row,
        action,
        actor,
        actorIsSuperAdmin: input.actorIsSuperAdmin === true,
        resolutionKey: input.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof ChatbotRequestCommandError && !error.current) {
        throw new ChatbotRequestCommandError(
          error.code,
          error.httpStatus,
          current(),
        );
      }
      throw error;
    }
    // One answer per customer (R9), after the wrapped row was written.
    await this.store.enqueueAnswered([
      row.id,
      ...siblings.map((sibling) => sibling.id),
    ]);
    await this.store.refreshGroups([
      row.customerKey,
      ...siblings.map((sibling) => sibling.customerKey),
    ]);
  }

  /** `GET :id/zone-impact`: what approving or rejecting would settle (R9). */
  async zoneImpact(requestId: string): Promise<ZoneImpactView> {
    const { found, impact } = await this.store.readZoneImpact(requestId);
    if (!found) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    if (!impact)
      throw new ChatbotRequestCommandError('ACTION_NOT_ALLOWED', 422);
    return impact;
  }

  private decide(
    state: ChatbotRequestState,
    input: StaffCommandInput,
    actor: StaffActor,
    toUser: StaffActor | null,
  ): CommandResult {
    const now = new Date();
    const { expectedVersion, actorCanReassign, command } = input;
    switch (command.kind) {
      case 'claim':
        return claim(state, { actor, expectedVersion, now });
      case 'release':
        return release(state, { actor, expectedVersion, actorCanReassign });
      case 'reassign':
        return reassign(state, {
          actor,
          expectedVersion,
          toUser: toUser as StaffActor,
          note: command.note,
          now,
        });
      case 'cancel':
        return cancelByStaff(state, {
          actor,
          actorCanReassign,
          expectedVersion,
          reason: command.reason,
          note: command.note,
          customerNote: command.customerNote,
          now,
        });
      case 'reply':
        return reply(state, {
          actor,
          expectedVersion,
          replyId: randomUUID(),
          text: command.text,
          now,
        });
      case 'finish':
        return finish(state, {
          actor,
          actorCanReassign,
          expectedVersion,
          note: command.note,
          complaintOutcome: command.complaintOutcome,
          now,
        });
      case 'resolve':
        return resolve(state, {
          actor,
          expectedVersion,
          action: command.action.type,
          resolution: toResolution(command.action),
          now,
        });
    }
  }
}
