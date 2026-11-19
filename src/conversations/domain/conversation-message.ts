/**
 * DOMAIN: what the bot may write into the conversation mirror (human-
 * intervention unit 9; contract §3.6, §3.9, §4.1, §6.1, §11.2). Pure: no
 * database, no HTTP.
 *
 * Everything in a batch is untrusted (a customer typed it, the bot relayed
 * it). The parsers are exact: unknown keys, bad shapes, an author the bot may
 * not claim, a duplicated id or an oversized text are a `400 VALIDATION_ERROR`
 * (one `InvalidArgumentError`, nothing from the input is echoed). The tenant,
 * `seq`, the staff user, the delivery status and the retention date never come
 * from the bot. Text is stored verbatim, minus control and bidi-override
 * characters; it is never interpreted as HTML (the frontend renders text).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const CONVERSATION_LIMITS = {
  /** §3.6, §6.4: messages per `messages:batch` call (`413 BATCH_TOO_LARGE`). */
  batchMax: 50,
  /** Statuses per `statuses:batch` call (a technical bound; the contract has none). */
  statusBatchMax: 100,
  /** §3.6: `text <= 4096` characters (WhatsApp's own limit). */
  textMax: 4096,
  conversationRefMax: 200,
  waMessageIdMax: 255,
  /** §3.6: `purgeAfter = receivedAt + 12 months`. */
  retentionMonths: 12,
  /** A bot clock may run slightly ahead; anything further is a bug. */
  futureSkewMs: 5 * 60_000,
  /** Meta did not exist for WhatsApp Business before this. */
  earliestTimestamp: Date.parse('2020-01-01T00:00:00.000Z'),
} as const;

/** Thrown over the cap; the service answers `413 BATCH_TOO_LARGE`. */
export class MessageBatchTooLargeError extends Error {
  constructor(readonly limit: number) {
    super('batch too large');
    this.name = 'MessageBatchTooLargeError';
  }
}

const invalid = (): never => {
  throw new InvalidArgumentError('Invalid conversation request');
};

const REF = /^[A-Za-z0-9:_.@+-]{1,200}$/;
const WA_ID = /^wa:(\d{8,15})$/;
const WA_MESSAGE_ID = /^[A-Za-z0-9._=+/:-]{1,255}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** C0 (except tab, LF, CR), DEL, C1 and the bidi embedding/override/isolate marks. */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function parseConversationRef(value: unknown): string {
  if (typeof value !== 'string' || !REF.test(value)) return invalid();
  return value;
}

/**
 * R1: the same key `canonicalPhone` gives the request for this chat. WhatsApp's
 * Mexican `521` + 10 digits and `52` + 10 digits are the same person. `null`
 * when the reference is not a `wa:<wa_id>`.
 */
export function customerKeyFromConversationRef(ref: string): string | null {
  const digits = WA_ID.exec(ref)?.[1];
  if (!digits) return null;
  return digits.length === 13 && digits.startsWith('521')
    ? `52${digits.slice(3)}`
    : digits;
}

export function sanitizeMessageText(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function parseTimestamp(value: unknown, now: Date): Date {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return invalid();
  const ms = Date.parse(value);
  if (
    Number.isNaN(ms) ||
    ms < CONVERSATION_LIMITS.earliestTimestamp ||
    ms > now.getTime() + CONVERSATION_LIMITS.futureSkewMs
  ) {
    return invalid();
  }
  return new Date(ms);
}

function parseWaId(value: unknown): string {
  if (typeof value !== 'string' || !WA_MESSAGE_ID.test(value)) return invalid();
  return value;
}

// ------------------------------------------------------------- messages

export const BOT_MESSAGE_TYPES = [
  'TEXT',
  'IMAGE',
  'STICKER',
  'DOCUMENT',
  'AUDIO',
  'TEMPLATE',
  'UNSUPPORTED',
] as const;
export type BotMessageType = (typeof BOT_MESSAGE_TYPES)[number];

/** Types that point at a stored file (`POST /chatbot-api/media`). */
export const MEDIA_MESSAGE_TYPES: readonly BotMessageType[] = [
  'IMAGE',
  'STICKER',
  'DOCUMENT',
  'AUDIO',
];

/** §12.5: what the timeline shows for a message the backend does not store. */
const UNSUPPORTED_TEXT = {
  VIDEO: 'Video recibido',
  LOCATION: 'Ubicación recibida',
  OTHER: 'Mensaje no compatible recibido',
} as const;

export interface ParsedMessage {
  waMessageId: string;
  direction: 'IN' | 'OUT';
  /** Derived from the direction: the bot can only relay the customer or itself. */
  author: 'CUSTOMER' | 'BOT';
  type: BotMessageType;
  text: string | null;
  mediaId: string | null;
  /**
   * Unit 10: the `replyId` of the `request.answered` item this message carries
   * (an outgoing TEXT only). The store attributes the message to the staff
   * member of that reply (author STAFF); the bot never names the author.
   */
  staffReplyId?: string | null;
  /** Meta's timestamp. */
  providerTimestamp: Date;
  /** The bot's own clock when it saw the message (display only; seq is ours). */
  observedAt: Date;
}

const MESSAGE_KEYS = new Set([
  'waMessageId',
  'direction',
  'author',
  'type',
  'text',
  'mediaId',
  'kind',
  'staffReplyId',
  'providerTimestamp',
  'observedAt',
]);

function parseText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return invalid();
  const text = sanitizeMessageText(value);
  // WhatsApp counts characters, and so does `VARCHAR(4096)`.
  if (Array.from(text).length > CONVERSATION_LIMITS.textMax) return invalid();
  return text.trim().length === 0 ? null : text;
}

function parseOne(raw: unknown, now: Date): ParsedMessage {
  if (!isPlainObject(raw)) return invalid();
  onlyKeys(raw, MESSAGE_KEYS);
  const waMessageId = parseWaId(raw.waMessageId);
  const direction = raw.direction;
  if (direction !== 'IN' && direction !== 'OUT') return invalid();
  const author = direction === 'IN' ? 'CUSTOMER' : 'BOT';
  // Staff and system messages are written by the backend (§4.1): a bot that
  // claims one is a bug, not something to accept as another author.
  if (raw.author !== undefined && raw.author !== author) return invalid();
  const type = raw.type;
  if (!(BOT_MESSAGE_TYPES as readonly unknown[]).includes(type)) {
    return invalid();
  }
  const messageType = type as BotMessageType;
  if (messageType === 'TEMPLATE' && direction !== 'OUT') return invalid();
  if (raw.kind !== undefined && messageType !== 'UNSUPPORTED') return invalid();
  let staffReplyId: string | null = null;
  if (raw.staffReplyId !== undefined) {
    // Only the outgoing text of a staff reply carries one (unit 10).
    if (
      typeof raw.staffReplyId !== 'string' ||
      direction !== 'OUT' ||
      messageType !== 'TEXT'
    ) {
      return invalid();
    }
    staffReplyId = raw.staffReplyId.toLowerCase();
    if (!UUID.test(staffReplyId)) return invalid();
  }

  let text = parseText(raw.text);
  let mediaId: string | null = null;
  if (MEDIA_MESSAGE_TYPES.includes(messageType)) {
    if (typeof raw.mediaId !== 'string' || !UUID.test(raw.mediaId)) {
      return invalid();
    }
    mediaId = raw.mediaId;
  } else if (raw.mediaId !== undefined && raw.mediaId !== null) {
    return invalid();
  }

  if (messageType === 'TEXT' && text === null) return invalid();
  if (messageType === 'UNSUPPORTED') {
    // The words of a message the backend does not store are never kept.
    if (raw.text !== undefined && raw.text !== null) return invalid();
    const kind = raw.kind ?? 'OTHER';
    if (kind !== 'VIDEO' && kind !== 'LOCATION' && kind !== 'OTHER') {
      return invalid();
    }
    text = UNSUPPORTED_TEXT[kind];
  }

  return {
    waMessageId,
    direction,
    author,
    type: messageType,
    text,
    mediaId,
    staffReplyId,
    providerTimestamp: parseTimestamp(raw.providerTimestamp, now),
    observedAt: parseTimestamp(raw.observedAt, now),
  };
}

export function parseMessageBatch(body: unknown, now: Date): ParsedMessage[] {
  if (!isPlainObject(body)) return invalid();
  onlyKeys(body, new Set(['messages']));
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return invalid();
  if (messages.length > CONVERSATION_LIMITS.batchMax) {
    throw new MessageBatchTooLargeError(CONVERSATION_LIMITS.batchMax);
  }
  const parsed = messages.map((m) => parseOne(m, now));
  const ids = new Set(parsed.map((m) => m.waMessageId));
  if (ids.size !== parsed.length) return invalid();
  const replyIds = parsed.flatMap((m) =>
    m.staffReplyId ? [m.staffReplyId] : [],
  );
  if (new Set(replyIds).size !== replyIds.length) return invalid();
  return parsed;
}

// -------------------------------------------------------------- statuses

/** The statuses Meta reports; QUEUED, DEFERRED and UNKNOWN belong to the backend. */
export const BOT_DELIVERY_STATUSES = [
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
] as const;
export type BotDeliveryStatus = (typeof BOT_DELIVERY_STATUSES)[number];

export interface ParsedStatus {
  providerMessageId: string;
  status: BotDeliveryStatus;
  /** When Meta reported it (validated: not in the far future). */
  occurredAt: Date;
  /** Meta's error code of a `FAILED` status, when the bot sent one. */
  errorCode: string | null;
}

/**
 * S16 4: Meta error 131047 ("re-engagement message": the 24 h window is
 * closed). A `FAILED` status carrying it on a STAFF message is not a failure
 * of the message but a closed window: the message waits (DEFERRED) like
 * `DEFERRED_WINDOW_CLOSED` and is resent when the customer writes again.
 */
export const WINDOW_CLOSED_ERROR_CODE = '131047';

const STATUS_KEYS = new Set([
  'providerMessageId',
  'status',
  'occurredAt',
  'errorCode',
]);

export function parseStatusBatch(body: unknown, now: Date): ParsedStatus[] {
  if (!isPlainObject(body)) return invalid();
  onlyKeys(body, new Set(['statuses']));
  const statuses = body.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return invalid();
  if (statuses.length > CONVERSATION_LIMITS.statusBatchMax) {
    throw new MessageBatchTooLargeError(CONVERSATION_LIMITS.statusBatchMax);
  }
  return statuses.map((raw): ParsedStatus => {
    if (!isPlainObject(raw)) return invalid();
    onlyKeys(raw, STATUS_KEYS);
    const status = raw.status;
    if (!(BOT_DELIVERY_STATUSES as readonly unknown[]).includes(status)) {
      return invalid();
    }
    const occurredAt = parseTimestamp(raw.occurredAt, now);
    // The code is only read for the window rule (no column stores it).
    if (
      raw.errorCode !== undefined &&
      (typeof raw.errorCode !== 'string' ||
        raw.errorCode.length === 0 ||
        raw.errorCode.length > 64)
    ) {
      return invalid();
    }
    return {
      providerMessageId: parseWaId(raw.providerMessageId),
      status: status as BotDeliveryStatus,
      occurredAt,
      errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : null,
    };
  });
}
