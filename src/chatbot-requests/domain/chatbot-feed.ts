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
  'STALE',
] as const;
export type FeedOutcome = (typeof FEED_OUTCOMES)[number];

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
 * `OUTCOME_ALREADY_RECORDED`. `DEFERRED_WINDOW_CLOSED` is not terminal: a later
 * attempt may defer again or end it. The bot never defers a staff cancellation
 * notice (§12.14), so it cannot be left pending.
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
    input.outcome === 'DEFERRED_WINDOW_CLOSED' &&
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
const money = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

/**
 * `request.answered` payload of a wrapped decision: `{kind, text, prefix}` as
 * the §3.3 example, the structured fields the legacy poll gives (so the bot can
 * map them), and `legacyId`, the id the bot already tracks from the create
 * answer. `text` is the fixed Spanish text of the chosen option, or what staff
 * wrote for the customer (then `prefix` is the team prefix).
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
        ...(text ? { expirationText: text } : {}),
      };
    }
    case 'DELIVERY_ZONE': {
      const { zipCode: zip, zoneType, surchargeCents, etaDays } = source;
      const eta = etaDays ? ` Tiempo estimado: ${days(etaDays)}.` : '';
      const where = `en tu código postal (${zip})`;
      const text = {
        FREE: `Sí entregamos ${where}, sin costo de envío.${eta}`,
        SURCHARGE: `Sí entregamos ${where} con un cargo de envío de ${money(surchargeCents ?? 0)}.${eta}`,
        CARRIER_ONLY: `En tu código postal (${zip}) el envío es solo por paquetería.${eta}`,
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
          text: 'Recibimos y confirmamos tu comprobante de pago. ¡Gracias!',
          prefix: null,
        };
      }
      const reason = source.customerReason;
      return {
        ...base,
        subtype: 'TRANSFER_RECEIPT',
        action: 'REJECT_RECEIPT',
        text:
          reason ||
          'No pudimos validar tu comprobante. Por favor envíalo de nuevo o contáctanos.',
        prefix: reason ? TEAM_REPLY_PREFIX : null,
        ...(reason ? { customerReason: reason } : {}),
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
