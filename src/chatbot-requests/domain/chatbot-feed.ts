/**
 * DOMAIN: the bot feed (human-intervention unit 5, slice 5b; contract §3.3,
 * §6.4, §12.14). Pure: cursor and query parsing, the delivery outcome body and
 * its evidence hash, the one-terminal-ACK rule and the payload of each feed
 * item type. No database, no HTTP.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const FEED_TYPE = {
  answered: 'request.answered',
  cancelled: 'request.cancelled',
} as const;
export type FeedType = (typeof FEED_TYPE)[keyof typeof FEED_TYPE];

/** §3.3 and §6.4: 30 days of retention, a 25 s long-poll, 2 per credential. */
export const FEED_LIMITS = {
  retentionDays: 30,
  defaultLimit: 50,
  maxLimit: 50,
  defaultWaitSeconds: 25,
  maxWaitSeconds: 25,
  maxConcurrentPolls: 2,
} as const;

/** `NOTIFY` channel of the feed (R7); the payload is the tenant id only. */
export const FEED_CHANNEL = 'chatbot_feed';

/** The prefix of replies that staff wrote (§3.3 example, §12.14). */
export const TEAM_REPLY_PREFIX = 'Le comparto la respuesta del equipo:';

const bad = (): never => {
  throw new InvalidArgumentError(
    'Invalid feed request',
    'INVALID_FEED_REQUEST',
  );
};

// -------------------------------------------------------------- cursor, query

export const formatCursor = (cursor: bigint): string =>
  cursor.toString().padStart(12, '0');

/** A missing cursor is the start of the retained feed. */
export function parseCursor(raw: unknown): bigint {
  if (raw === undefined) return 0n;
  if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw)) return bad();
  return BigInt(raw);
}

function parseBounded(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return bad();
  const value = Number(raw);
  return value < min || value > max ? bad() : value;
}

/** Out-of-range values are a 400, never clamped. */
export function parseFeedQuery(query: {
  after?: unknown;
  limit?: unknown;
  waitSeconds?: unknown;
}): { after: bigint; limit: number; waitSeconds: number } {
  return {
    after: parseCursor(query.after),
    limit: parseBounded(
      query.limit,
      FEED_LIMITS.defaultLimit,
      1,
      FEED_LIMITS.maxLimit,
    ),
    waitSeconds: parseBounded(
      query.waitSeconds,
      FEED_LIMITS.defaultWaitSeconds,
      0,
      FEED_LIMITS.maxWaitSeconds,
    ),
  };
}

// ------------------------------------------------------------------- outcome

export const FEED_OUTCOMES = [
  'PROVIDER_ACCEPTED',
  'DELIVERY_UNKNOWN',
  'DEFERRED_WINDOW_CLOSED',
  'DEFERRED_HUMAN_SESSION',
  'STALE',
] as const;
export type FeedOutcome = (typeof FEED_OUTCOMES)[number];

/**
 * The non-terminal outcomes: the delivery stays pending (`ackedAt` NULL) and
 * `pending-deliveries` serves it. The window deferral waits for the customer's
 * next message; the human-session deferral waits for the session to end
 * (`conversation.ended`) or for the next bot-mode turn.
 */
export const DEFERRED_OUTCOMES = [
  'DEFERRED_WINDOW_CLOSED',
  'DEFERRED_HUMAN_SESSION',
] as const;
export type DeferredOutcome = (typeof DEFERRED_OUTCOMES)[number];
export type DeferredReason = 'WINDOW_CLOSED' | 'HUMAN_SESSION';

export const isDeferredOutcome = (
  outcome: string | null | undefined,
): outcome is DeferredOutcome =>
  DEFERRED_OUTCOMES.some((deferred) => deferred === outcome);

/** Why a pending delivery is waiting; `null` for anything that is not a deferral. */
export function deferredReasonOf(
  outcome: string | null | undefined,
): DeferredReason | null {
  if (outcome === 'DEFERRED_WINDOW_CLOSED') return 'WINDOW_CLOSED';
  if (outcome === 'DEFERRED_HUMAN_SESSION') return 'HUMAN_SESSION';
  return null;
}

export interface FeedOutcomeInput {
  attemptId: string;
  outcome: FeedOutcome;
  attemptedAt?: string;
  providerMessageId?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MESSAGE_ID_MAX = 512;

function readTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_UTC.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return bad();
  }
  return value;
}

function readMessageId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MESSAGE_ID_MAX ||
    value.trim() !== value ||
    value.normalize('NFC') !== value ||
    // eslint-disable-next-line no-control-regex -- rejecting C0/DEL/C1 is the point
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    return bad();
  }
  return value;
}

/**
 * Body of `POST /chatbot-api/deliveries/:deliveryId/outcome` (§3.3): exactly
 * `{attemptId, outcome, attemptedAt, providerMessageId?}`. `STALE` is a
 * no-send, so `attemptedAt` is optional there; `providerMessageId` is required
 * for `PROVIDER_ACCEPTED`, optional for `DELIVERY_UNKNOWN`, forbidden otherwise.
 * An unknown key is rejected, never stripped.
 */
export function parseFeedOutcome(body: unknown): FeedOutcomeInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return bad();
  }
  // JSON cannot carry `undefined`, so an undefined value is an absent key.
  const raw = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
  const allowed = ['attemptId', 'outcome', 'attemptedAt', 'providerMessageId'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return bad();
  const outcome = FEED_OUTCOMES.find((value) => value === raw.outcome);
  if (!outcome) return bad();
  if (typeof raw.attemptId !== 'string') return bad();
  const attemptId = raw.attemptId.trim().toLowerCase();
  if (!UUID.test(attemptId)) return bad();

  const result: FeedOutcomeInput = { attemptId, outcome };
  if (outcome !== 'STALE' || 'attemptedAt' in raw) {
    result.attemptedAt = readTimestamp(raw.attemptedAt);
  }
  const hasMessageId = 'providerMessageId' in raw;
  if (outcome === 'PROVIDER_ACCEPTED' && !hasMessageId) return bad();
  if (
    hasMessageId &&
    outcome !== 'PROVIDER_ACCEPTED' &&
    outcome !== 'DELIVERY_UNKNOWN'
  ) {
    return bad();
  }
  if (hasMessageId)
    result.providerMessageId = readMessageId(raw.providerMessageId);
  return result;
}

/** The server derives the idempotency identity; a client hash is never read. */
export function hashFeedOutcome(input: FeedOutcomeInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        attemptId: input.attemptId,
        attemptedAt: input.attemptedAt ?? null,
        outcome: input.outcome,
        providerMessageId: input.providerMessageId ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

export type OutcomeDecision =
  | 'APPLY'
  | 'REPLAY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OUTCOME_ALREADY_RECORDED'
  | 'OUTCOME_NOT_ALLOWED';

/**
 * One terminal ACK per delivery, as `HumanDecisionBotOutcome`: the same
 * attempt with the same evidence replays; the same attempt with other evidence
 * is `IDEMPOTENCY_CONFLICT`; another attempt after a terminal outcome is
 * `OUTCOME_ALREADY_RECORDED`. A deferral (`DEFERRED_WINDOW_CLOSED`,
 * `DEFERRED_HUMAN_SESSION`) is not terminal: a later attempt may defer again,
 * for either reason, or end it. The bot never defers a staff cancellation
 * notice (§12.14: a notice that arrives late only annoys the customer, and that
 * holds whichever the reason), so it cannot be left pending.
 */
export function classifyOutcome(
  current: {
    type: string;
    attemptId: string | null;
    evidenceHash: string | null;
    ackedAt: Date | null;
  },
  input: FeedOutcomeInput,
  hash: string,
): OutcomeDecision {
  if (current.attemptId === input.attemptId) {
    return current.evidenceHash === hash ? 'REPLAY' : 'IDEMPOTENCY_CONFLICT';
  }
  if (current.ackedAt) return 'OUTCOME_ALREADY_RECORDED';
  if (
    isDeferredOutcome(input.outcome) &&
    current.type === FEED_TYPE.cancelled
  ) {
    return 'OUTCOME_NOT_ALLOWED';
  }
  return 'APPLY';
}

// ------------------------------------------------------------------ payloads

export type AnswerSource =
  | {
      subtype: 'RESTOCK';
      legacyId: string;
      productName: string;
      action:
        | 'PROVIDE_RESTOCK_ESTIMATE'
        | 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';
      restockDays: number | null;
    }
  | {
      subtype: 'EXPIRATION';
      legacyId: string;
      productName: string;
      action: 'PROVIDE_EXPIRATION_TEXT' | 'REPORT_EXPIRATION_UNAVAILABLE';
      expirationText: string | null;
    }
  | {
      subtype: 'DELIVERY_ZONE';
      legacyId: string;
      zipCode: string;
      zoneType: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED';
      surchargeCents: number | null;
      etaDays: number | null;
    }
  | {
      subtype: 'TRANSFER_RECEIPT';
      legacyId: string;
      status: 'CONFIRMED' | 'REJECTED';
      customerReason: string | null;
    };

export interface AnswerPayload {
  kind: 'DECISION';
  subtype: AnswerSource['subtype'];
  action: string;
  legacyId: string;
  text: string;
  prefix: string | null;
  [field: string]: unknown;
}

const days = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;

/** es-MX amount: `$1,250.00 MXN`. */
function money(cents: number): string {
  const pesos = Math.trunc(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${pesos}.${String(cents % 100).padStart(2, '0')} MXN`;
}

/**
 * The text `ReceiptReviewService` stores as `customerReason` when staff reject
 * without one (the v1 body). It is the legacy text, verbatim (tú, as stored):
 * the one default for a rejection, so a legacy rejection and a missing reason
 * read the same. A spec pins this copy to the sales module's constant; it is
 * copied, not imported, to keep the domain free of the sales module.
 */
export const LEGACY_DEFAULT_REJECTION_TEXT =
  'No pudimos validar tu comprobante. Por favor envíanos uno nuevo o contáctanos.';

/**
 * `request.answered` payload of a wrapped decision.
 *
 * The chatbot composes the customer message itself, with each customer's
 * tú/usted register (owner decision), **from the structured fields**:
 * `subtype`, `action`, `legacyId` (the id the bot tracks from the create
 * answer) and, per subtype, `productName`, `restockDays`, `zipCode`,
 * `zoneType`, `surchargeCents`, `etaDays`, `customerReason` and `staffText`
 * (text staff wrote for the customer, when there is one). `text` and `prefix`
 * are only a fallback, written in usted: `prefix` is the team prefix when
 * `text` is what staff wrote, else `null`.
 */
export function buildAnswerPayload(source: AnswerSource): AnswerPayload {
  const base = { kind: 'DECISION' as const, legacyId: source.legacyId };
  switch (source.subtype) {
    case 'RESTOCK': {
      const name = source.productName;
      const provided =
        source.action === 'PROVIDE_RESTOCK_ESTIMATE' && source.restockDays;
      return {
        ...base,
        subtype: 'RESTOCK',
        action: source.action,
        text: provided
          ? `El producto «${name}» estará disponible en aproximadamente ${days(provided)}.`
          : `Por ahora no tenemos una fecha estimada de reposición para «${name}».`,
        prefix: null,
        productName: name,
        ...(provided ? { restockDays: provided } : {}),
      };
    }
    case 'EXPIRATION': {
      const name = source.productName;
      const text =
        source.action === 'PROVIDE_EXPIRATION_TEXT' && source.expirationText;
      return {
        ...base,
        subtype: 'EXPIRATION',
        action: source.action,
        text:
          text || `Por ahora no tenemos la fecha de caducidad de «${name}».`,
        prefix: text ? TEAM_REPLY_PREFIX : null,
        productName: name,
        ...(text ? { expirationText: text, staffText: text } : {}),
      };
    }
    case 'DELIVERY_ZONE': {
      const { zipCode: zip, zoneType, surchargeCents, etaDays } = source;
      const eta = etaDays ? ` Tiempo estimado: ${days(etaDays)}.` : '';
      const where = `en su código postal (${zip})`;
      // A surcharge of null or 0 is "no amount": never render $0.00.
      const amount = surchargeCents ? money(surchargeCents) : null;
      const text = {
        FREE: `Sí entregamos ${where}, sin costo de envío.${eta}`,
        SURCHARGE: `Sí entregamos ${where} con un cargo de envío ${amount ? `de ${amount}` : 'adicional'}.${eta}`,
        CARRIER_ONLY: `En su código postal (${zip}) el envío es solo por paquetería.${amount ? ` El cargo de envío es de ${amount}.` : ''}${eta}`,
        DENIED: `Por ahora no entregamos ${where}.`,
      }[zoneType];
      return {
        ...base,
        subtype: 'DELIVERY_ZONE',
        action:
          zoneType === 'DENIED'
            ? 'REJECT_DELIVERY_ZONE'
            : 'APPROVE_DELIVERY_ZONE',
        text,
        prefix: null,
        zipCode: zip,
        zoneType,
        ...(surchargeCents === null ? {} : { surchargeCents }),
        ...(etaDays === null ? {} : { etaDays }),
      };
    }
    case 'TRANSFER_RECEIPT': {
      if (source.status === 'CONFIRMED') {
        return {
          ...base,
          subtype: 'TRANSFER_RECEIPT',
          action: 'CONFIRM_RECEIPT',
          text: 'Le confirmamos la recepción de su comprobante de pago. ¡Gracias!',
          prefix: null,
        };
      }
      // The legacy route stores its default when staff gave no reason: that is
      // not something staff wrote, so no team prefix and no `staffText`.
      const reason = source.customerReason || LEGACY_DEFAULT_REJECTION_TEXT;
      const fromStaff = reason !== LEGACY_DEFAULT_REJECTION_TEXT;
      return {
        ...base,
        subtype: 'TRANSFER_RECEIPT',
        action: 'REJECT_RECEIPT',
        text: reason,
        prefix: fromStaff ? TEAM_REPLY_PREFIX : null,
        customerReason: reason,
        reasonSource: fromStaff ? 'STAFF' : 'DEFAULT',
        ...(fromStaff ? { staffText: reason } : {}),
      };
    }
  }
}

/** `request.cancelled` (§12.14): no message of its own; the bot decides. */
export function buildCancelPayload(input: {
  requestId: string;
  reason: string;
  customerNote?: string;
}): Record<string, unknown> {
  return {
    requestId: input.requestId,
    reason: input.reason,
    cancelledBy: 'STAFF',
    ...(input.customerNote ? { customerNote: input.customerNote } : {}),
  };
}
