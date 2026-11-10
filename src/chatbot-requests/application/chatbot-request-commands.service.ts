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
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  cancelByStaff,
  claim,
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

export const CHATBOT_REQUEST_COMMAND_STORE = Symbol(
  'CHATBOT_REQUEST_COMMAND_STORE',
);

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
  | { kind: 'resolve'; action: string };

export interface StaffCommandInput {
  requestId: string;
  actorUserId: string;
  /** `update:ChatbotRequestAssignment`, from the caller's CASL ability. */
  actorCanReassign: boolean;
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
}

export type ChatbotRequestCommandErrorCode =
  | ChatbotRequestError['code']
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'USER_NOT_ASSIGNABLE';

export class ChatbotRequestCommandError extends Error {
  constructor(
    readonly code: ChatbotRequestCommandErrorCode,
    readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 422,
    readonly current?: ChatbotRequestError['current'],
  ) {
    super(code);
    this.name = 'ChatbotRequestCommandError';
  }
}

export const formatFolio = (folio: number) =>
  `S-${String(folio).padStart(6, '0')}`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toState(row: ChatbotRequestRow): ChatbotRequestState {
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

      const row = await this.store.lockRequest(input.requestId);
      if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      const result = this.decide(toState(row), input, actor, toUser);
      if (!result.ok) throw rejected(result.error);
      if (input.command.kind === 'resolve') {
        // Unit 3 resolves through the wrapped repository (R4); until then a
        // decision that would resolve is refused without a write.
        throw rejected({
          code: 'ACTION_NOT_ALLOWED',
          httpStatus: 422,
          current: {
            version: row.version,
            status: row.status,
            claimedBy: toView(row).assignee,
          },
        });
      }

      await this.store.apply(row, result.patch, result.event);
      const response = toView({ ...row, ...result.patch } as ChatbotRequestRow);
      await this.store.saveReceipt(actorId, key, hash, response);
      return response;
    });
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
          action: command.action,
          now,
        });
    }
  }
}
