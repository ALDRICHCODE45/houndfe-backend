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
import { createHash } from 'crypto';
import {
  cancelByStaff,
  claim,
  closeWrapped,
  displayStatus,
  reassign,
  release,
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
  type StaffActor,
  type StaffCancelReason,
} from '../domain/chatbot-request.commands';
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
  | { kind: 'resolve'; action: ResolveAction };

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
  assigneeUserId: string | null;
  assigneeDisplayName: string | null;
  claimedAt: Date | null;
  overdueAt: Date | null;
  closedAt: Date | null;
  humanDecisionId: string | null;
  deliveryZoneRequestId: string | null;
  receiptEvidenceId: string | null;
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
  | 'FORBIDDEN'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'ZONE_SET_CHANGED'
  // Bot intake (unit 5).
  | 'CUSTOMER_OPEN_LIMIT'
  | 'CUSTOMER_RATE_LIMITED'
  | 'SUBTYPE_DISABLED'
  | 'SCHEDULING_DISABLED';

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
    readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429,
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

export function toState(row: ChatbotRequestRow): ChatbotRequestState {
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
    // The live-session table arrives with unit 11; until then no request has
    // a started session.
    liveSessionState: null,
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
    return this.store.transaction(async () => {
      await this.store.lockIdempotencyKey(actorId, key);
      const receipt = await this.store.findReceipt(actorId, key);
      if (receipt) {
        if (receipt.commandHash !== hash) {
          throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
        }
        return receipt.responseSnapshot as ChatbotRequestView;
      }

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
      } else {
        await this.store.apply(row, result.patch, result.event);
      }
      const response = toView({ ...row, ...result.patch } as ChatbotRequestRow);
      await this.store.saveReceipt(actorId, key, hash, response);
      return response;
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
