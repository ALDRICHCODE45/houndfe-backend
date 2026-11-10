/**
 * APPLICATION: the bot's writes on chatbot requests (human-intervention unit
 * 5, slice 5a; contract §3.1, §3.2, §3.4, §3.5, §6.4).
 *
 * `create` (POST /chatbot-api/requests):
 *   - CLARIFICATION / TALK_TO_HUMAN / COMPLAINT create the request directly,
 *     in one READ COMMITTED transaction: key lock, replay, customer lock,
 *     dedup (merge), limits, folio, insert, group.
 *   - RESTOCK / EXPIRATION / DELIVERY_ZONE hand the legacy `detail` to the
 *     existing intake repositories, so the unit-3 hook wraps them in the same
 *     transaction as the wrapped row. The hook (envelope mode) does the
 *     customer lock, dedup and limits; when the request must merge it throws
 *     `IntakeMergeSignal`, which rolls the legacy transaction back, and the
 *     merge runs here, outside it.
 *   - Idempotency (§3.1): a merge has no request row to replay from, so it is
 *     stored as a receipt; a created request replays from its own row and
 *     `canonicalRequestHash`. Same hash → the same answer, another → 409.
 *
 * `cancel` (POST /chatbot-api/requests/:id/cancel): the customer closes an
 * open request. Lock order: key lock, postal-code lock (zones), request row,
 * group (docs/chatbot-requests-model.md).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  botEnvelopeHash,
  isDisabledSubtype,
  isToken,
  isUuid,
  isWrappedSubtype,
  parseBotEnvelope,
  type BotEnvelope,
  type WrappedSubtype,
} from '../domain/bot-request-envelope';
import { canonicalPhone } from '../domain/canonical-phone';
import {
  cancelByCustomer,
  type ChatbotRequestEventDraft,
  type ChatbotRequestPatch,
  type CustomerCancelReason,
} from '../domain/chatbot-request.commands';
import {
  ChatbotRequestWrapper,
  type BotIntakeEnvelope,
} from '../infrastructure/chatbot-request-wrapper';
import {
  DEFAULT_INTAKE_LIMITS,
  IntakeMergeSignal,
  type IntakeLimits,
} from '../infrastructure/chatbot-request-intake-writes';
import {
  ChatbotRequestCommandError,
  formatFolio,
  toState,
  type ChatbotRequestRow,
} from './chatbot-request-commands.service';

export const BOT_INTAKE_STORE = Symbol('BOT_INTAKE_STORE');
export const LEGACY_INTAKE = Symbol('LEGACY_INTAKE');
export const BOT_INTAKE_LIMITS = Symbol('BOT_INTAKE_LIMITS');

type ReceiptKind = 'CREATE' | 'CANCEL';
const MAX_ATTEMPTS = 3;

export interface IntakeOutcome {
  outcome: 'CREATED' | 'MERGED';
  id: string;
  folio: number;
  status: 'NEW' | 'IN_PROGRESS';
}

export interface DirectDraft {
  credentialId: string;
  envelope: BotEnvelope;
  hash: string;
  limits: IntakeLimits;
}

interface RequestRef {
  id: string;
  folio: number;
  canonicalRequestHash: string | null;
}

export interface BotIntakeStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Serializes retries of one key, so a concurrent retry replays. */
  lockKey(kind: ReceiptKind, key: string): Promise<void>;
  findReceipt(
    kind: ReceiptKind,
    key: string,
  ): Promise<{ commandHash: string; responseSnapshot: unknown } | null>;
  saveReceipt(
    kind: ReceiptKind,
    key: string,
    commandHash: string,
    requestId: string | null,
    snapshot: BotCreateResponse | BotCancelResponse,
  ): Promise<void>;
  /** A request the bot created itself, by its `sourceRequestId`. */
  findCreated(sourceRequestId: string): Promise<RequestRef | null>;
  /** The wrapper request of a legacy row, if the hook made one. */
  findWrapper(
    subtype: WrappedSubtype,
    wrappedId: string,
  ): Promise<RequestRef | null>;
  /** Link, customer lock, dedup, limits, folio, insert; or merge. */
  createDirect(draft: DirectDraft): Promise<IntakeOutcome>;
  /** Merges into the open request with the envelope's dedup key, if any. */
  mergeOpen(draft: DirectDraft): Promise<IntakeOutcome | null>;
  lockZoneOf(requestId: string): Promise<void>;
  lockRequest(requestId: string): Promise<ChatbotRequestRow | null>;
  applyCancel(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void>;
  readResolution(requestId: string): Promise<unknown>;
}

export interface LegacyIntakeResult {
  status: 'created' | 'replayed';
  /** Id of the wrapped legacy row (decision, or zone requester). */
  wrappedId: string;
  /** What the old route answers; the bot still polls those rows by id. */
  projection: unknown;
}

/** Runs today's intake for a wrapped subtype, parsers and errors included. */
export interface LegacyIntakePort {
  submit(
    subtype: WrappedSubtype,
    detail: Record<string, unknown>,
    credentialId: string,
  ): Promise<LegacyIntakeResult>;
}

export interface BotCreateResponse {
  id: string | null;
  folio: string | null;
  status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED';
  outcome: 'CREATED' | 'REPLAYED' | 'MERGED';
  mergedIntoId: string | null;
  /** The business calendar is unit 7; `null` until then. */
  businessHours: null;
  /** Wrapped subtypes: the legacy projection of the wrapped row. */
  legacy?: unknown;
}

export interface BotCreateResult {
  httpStatus: 200 | 201;
  body: BotCreateResponse;
}

export interface BotCancelResponse {
  id: string;
  status: 'CANCELLED';
  reason: CustomerCancelReason;
  cancelledAt: string;
}

const conflict = () =>
  new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
const invalid = () => new InvalidArgumentError('Invalid chatbot request body');

function view(
  ref: { id: string; folio: number },
  outcome: BotCreateResponse['outcome'],
  status: 'NEW' | 'IN_PROGRESS' = 'NEW',
): BotCreateResponse {
  const merged = outcome === 'MERGED';
  return {
    id: ref.id,
    folio: formatFolio(ref.folio),
    status,
    outcome,
    mergedIntoId: merged ? ref.id : null,
    businessHours: null,
  };
}

@Injectable()
export class BotRequestIntakeService {
  constructor(
    @Inject(BOT_INTAKE_STORE) private readonly store: BotIntakeStore,
    @Inject(LEGACY_INTAKE) private readonly legacy: LegacyIntakePort,
    private readonly wrapper: ChatbotRequestWrapper,
    @Optional()
    @Inject(BOT_INTAKE_LIMITS)
    private readonly limits: IntakeLimits = DEFAULT_INTAKE_LIMITS,
  ) {}

  async create(input: {
    credentialId: string;
    idempotencyKey: string | undefined;
    body: unknown;
  }): Promise<BotCreateResult> {
    const envelope = parseBotEnvelope(input.body);
    // §3.1: the key is the body's own id, compared literally.
    if (input.idempotencyKey !== envelope.sourceRequestId) throw invalid();
    if (isDisabledSubtype(envelope.subtype)) {
      throw new ChatbotRequestCommandError('SUBTYPE_DISABLED', 422);
    }
    if (envelope.scheduledFor) {
      // Scheduled conversations are unit 14 (§4.9, §10).
      throw new ChatbotRequestCommandError('SCHEDULING_DISABLED', 422);
    }
    if (isWrappedSubtype(envelope.subtype)) assertDetail(envelope);

    const draft: DirectDraft = {
      credentialId: input.credentialId,
      envelope,
      hash: botEnvelopeHash(envelope),
      limits: this.limits,
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return isWrappedSubtype(envelope.subtype)
          ? await this.createWrapped(draft, envelope.subtype)
          : await this.createDirect(draft);
      } catch (error) {
        if (!(error instanceof IntakeMergeSignal)) throw error;
        if (isWrappedSubtype(envelope.subtype)) {
          const merged = await this.mergeAfterSignal(draft);
          if (merged) return merged;
        }
      }
    }
    // Only a request that opens and closes between every attempt gets here.
    throw new ChatbotRequestCommandError('VERSION_CONFLICT', 409);
  }

  private createDirect(draft: DirectDraft): Promise<BotCreateResult> {
    const { envelope } = draft;
    return this.store.transaction(async () => {
      await this.store.lockKey('CREATE', envelope.sourceRequestId);
      const replay = await this.replayOf(draft);
      if (replay) return replay;
      const made = await this.store.createDirect(draft);
      return this.finish(draft, made);
    });
  }

  /**
   * The answer stored for this key, if any. Every successful create stores one
   * (direct, merged or wrapped), so a key reused with another body, or on the
   * other path, is a conflict instead of a second request.
   */
  private async storedAnswer(
    draft: DirectDraft,
  ): Promise<BotCreateResponse | null> {
    const receipt = await this.store.findReceipt(
      'CREATE',
      draft.envelope.sourceRequestId,
    );
    if (!receipt) return null;
    if (receipt.commandHash !== draft.hash) throw conflict();
    return receipt.responseSnapshot as BotCreateResponse;
  }

  /** The stored answer (a created one replays), else the row this key made. */
  private async replayOf(draft: DirectDraft): Promise<BotCreateResult | null> {
    const stored = await this.storedAnswer(draft);
    if (stored) {
      return {
        httpStatus: 200,
        body:
          stored.outcome === 'MERGED'
            ? stored
            : { ...stored, outcome: 'REPLAYED' },
      };
    }
    const created = await this.store.findCreated(
      draft.envelope.sourceRequestId,
    );
    if (!created) return null;
    if (created.canonicalRequestHash !== draft.hash) throw conflict();
    return { httpStatus: 200, body: view(created, 'REPLAYED') };
  }

  /** The answer is stored, so a retry of its key answers the same. */
  private async finish(
    draft: DirectDraft,
    made: IntakeOutcome,
  ): Promise<BotCreateResult> {
    const merged = made.outcome === 'MERGED';
    const body = merged
      ? view(made, 'MERGED', made.status)
      : view(made, 'CREATED');
    await this.store.saveReceipt(
      'CREATE',
      draft.envelope.sourceRequestId,
      draft.hash,
      made.id,
      body,
    );
    return { httpStatus: merged ? 200 : 201, body };
  }

  private async createWrapped(
    draft: DirectDraft,
    subtype: WrappedSubtype,
  ): Promise<BotCreateResult> {
    const { envelope } = draft;
    const early = await this.store.transaction(() => this.replayOfMerge(draft));
    if (early) return early;

    const legacy = await this.wrapper.withEnvelope(
      this.botEnvelope(draft),
      () => this.legacy.submit(subtype, envelope.detail, draft.credentialId),
    );
    const wrapper = await this.store.findWrapper(subtype, legacy.wrappedId);
    // A requester resolved by an existing zone is never wrapped (§2.3).
    if (!wrapper) {
      return {
        httpStatus: legacy.status === 'created' ? 201 : 200,
        body: {
          id: null,
          folio: null,
          status: 'RESOLVED',
          outcome: legacy.status === 'created' ? 'CREATED' : 'REPLAYED',
          mergedIntoId: null,
          businessHours: null,
          legacy: legacy.projection,
        },
      };
    }
    if (legacy.status === 'replayed') {
      // Created through the old route, the wrapper has no bot hash to compare.
      if (
        wrapper.canonicalRequestHash &&
        wrapper.canonicalRequestHash !== draft.hash
      ) {
        throw conflict();
      }
    }
    const created = legacy.status === 'created';
    return {
      httpStatus: created ? 201 : 200,
      body: {
        ...view(wrapper, created ? 'CREATED' : 'REPLAYED'),
        legacy: legacy.projection,
      },
    };
  }

  /**
   * Wrapped path: a stored merge replays as is; another hash (this key was
   * used with another body or by the direct path) conflicts; a stored create
   * of the same hash is replayed by the legacy intake, which has the wrapped
   * row to answer with.
   */
  private async replayOfMerge(
    draft: DirectDraft,
  ): Promise<BotCreateResult | null> {
    const stored = await this.storedAnswer(draft);
    return stored?.outcome === 'MERGED'
      ? { httpStatus: 200, body: stored }
      : null;
  }

  /** After the legacy transaction rolled back: merge, or let the loop retry. */
  private mergeAfterSignal(
    draft: DirectDraft,
  ): Promise<BotCreateResult | null> {
    return this.store.transaction(async () => {
      await this.store.lockKey('CREATE', draft.envelope.sourceRequestId);
      const replay = await this.replayOfMerge(draft);
      if (replay) return replay;
      const merged = await this.store.mergeOpen(draft);
      return merged ? this.finish(draft, merged) : null;
    });
  }

  private botEnvelope(draft: DirectDraft): BotIntakeEnvelope {
    const { envelope } = draft;
    return {
      credentialId: draft.credentialId,
      sourceRequestId: envelope.sourceRequestId,
      hash: draft.hash,
      customer: envelope.customer,
      summary: envelope.summary,
      needs: envelope.needs,
      context: envelope.context,
      dedupKey: envelope.dedupKey,
      conversationRef: envelope.conversationRef,
      lastCustomerMessageAt: envelope.lastCustomerMessageAt,
      triggerWaMessageId: envelope.triggerWaMessageId,
      limits: draft.limits,
    };
  }

  // ------------------------------------------------------------------ cancel

  async cancel(input: {
    credentialId: string;
    idempotencyKey: string | undefined;
    requestId: string;
    body: unknown;
  }): Promise<BotCancelResponse> {
    const { key, reason, triggerWaMessageId } = parseCancel(
      input.idempotencyKey,
      input.body,
    );
    const hash = createHash('sha256')
      .update(JSON.stringify([input.requestId, reason, triggerWaMessageId]))
      .digest('hex');
    return this.store.transaction(async () => {
      await this.store.lockKey('CANCEL', key);
      const receipt = await this.store.findReceipt('CANCEL', key);
      if (receipt) {
        if (receipt.commandHash !== hash) throw conflict();
        return receipt.responseSnapshot as BotCancelResponse;
      }
      // Rule 5: a zone's postal-code lock comes before any request row.
      await this.store.lockZoneOf(input.requestId);
      const row = await this.store.lockRequest(input.requestId);
      if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);

      const now = new Date();
      const result = cancelByCustomer(toState(row), {
        credentialId: input.credentialId,
        reason,
        now,
      });
      if (!result.ok) {
        const { code, httpStatus, current } = result.error;
        // §3.4: the bot delivers the answer instead of saying "cancelled".
        const extra =
          code === 'ALREADY_RESOLVED'
            ? { resolution: await this.store.readResolution(row.id) }
            : undefined;
        throw new ChatbotRequestCommandError(code, httpStatus, current, extra);
      }
      await this.store.applyCancel(row, result.patch, {
        ...result.event,
        data: { ...result.event.data, triggerWaMessageId },
      });
      const response: BotCancelResponse = {
        id: row.id,
        status: 'CANCELLED',
        reason,
        cancelledAt: now.toISOString(),
      };
      await this.store.saveReceipt('CANCEL', key, hash, row.id, response);
      return response;
    });
  }
}

/** The legacy body must be today's body for this very request (§3.2). */
function assertDetail(envelope: BotEnvelope): void {
  const { detail } = envelope;
  if (
    detail.sourceRequestId !== envelope.sourceRequestId ||
    detail.type !== envelope.subtype
  ) {
    throw invalid();
  }
  const phone = detail.phone;
  const cc = detail.phoneCountryCode;
  if (
    envelope.subtype === 'DELIVERY_ZONE' &&
    envelope.customer &&
    typeof phone === 'string' &&
    typeof cc === 'string' &&
    canonicalPhone(cc, phone) !==
      canonicalPhone(
        envelope.customer.phoneCountryCode,
        envelope.customer.phone,
      )
  ) {
    throw invalid();
  }
}

function parseCancel(
  key: string | undefined,
  body: unknown,
): {
  key: string;
  reason: CustomerCancelReason;
  triggerWaMessageId: string;
} {
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (
    !isUuid(key) ||
    !record ||
    Object.keys(record).some(
      (name) => name !== 'reason' && name !== 'triggerWaMessageId',
    ) ||
    (record.reason !== 'CUSTOMER_WITHDREW' &&
      record.reason !== 'AUTO_RESOLVED') ||
    !isToken(record.triggerWaMessageId)
  ) {
    throw invalid();
  }
  return {
    key,
    reason: record.reason,
    triggerWaMessageId: record.triggerWaMessageId,
  };
}
