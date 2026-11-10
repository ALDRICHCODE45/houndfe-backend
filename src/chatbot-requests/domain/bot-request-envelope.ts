/**
 * DOMAIN: the body of `POST /chatbot-api/requests` (contract §3.2): the common
 * envelope plus the per-subtype `detail`. Everything in it is untrusted, so
 * the parser is exact: unknown keys, bad shapes and control characters are a
 * `400 VALIDATION_ERROR` (any failure throws one `InvalidArgumentError`,
 * nothing from the input is echoed). The tenant, source and credential are
 * never part of the body (§3.1).
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { canonicalPhone } from './canonical-phone';

export const WRAPPED_SUBTYPES = [
  'RESTOCK',
  'EXPIRATION',
  'DELIVERY_ZONE',
] as const;
export const DIRECT_SUBTYPES = [
  'UNKNOWN_QUESTION',
  'TALK_TO_HUMAN',
  'COMPLAINT',
] as const;
/** Known but not created through this route (§3.2, §7.1): 422 SUBTYPE_DISABLED. */
const DISABLED_SUBTYPES = ['TRANSFER_RECEIPT', 'DISCOUNT'] as const;

export type WrappedSubtype = (typeof WRAPPED_SUBTYPES)[number];
export type DirectSubtype = (typeof DIRECT_SUBTYPES)[number];
export type EnvelopeSubtype =
  | WrappedSubtype
  | DirectSubtype
  | (typeof DISABLED_SUBTYPES)[number];

export const isWrappedSubtype = (
  subtype: EnvelopeSubtype,
): subtype is WrappedSubtype =>
  (WRAPPED_SUBTYPES as readonly string[]).includes(subtype);

export const isDisabledSubtype = (subtype: EnvelopeSubtype) =>
  (DISABLED_SUBTYPES as readonly string[]).includes(subtype);

export interface BotEnvelope {
  sourceRequestId: string;
  subtype: EnvelopeSubtype;
  customer: { phoneCountryCode: string; phone: string } | null;
  conversationRef: string | null;
  lastCustomerMessageAt: Date | null;
  summary: string | null;
  needs: string | null;
  context: Record<string, string | number | string[]> | null;
  dedupKey: string | null;
  triggerWaMessageId: string | null;
  /** Scheduling is unit 14: the service refuses a value until then. */
  scheduledFor: Date | null;
  /** The legacy body of a wrapped subtype; `{}` for the others. */
  detail: Record<string, unknown>;
}

const KEYS = new Set([
  'sourceRequestId',
  'subtype',
  'customer',
  'conversationRef',
  'lastCustomerMessageAt',
  'summary',
  'needs',
  'context',
  'dedupKey',
  'triggerWaMessageId',
  'scheduledFor',
  'detail',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9:_\-.]{1,200}$/;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN.test(value);
const ID = /^[A-Za-z0-9:_\-.]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_NO_NEWLINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** `context` carries ids and quantities only, never prices (§6.1). */
const CONTEXT_IDS = ['cartRef', 'saleId', 'orderId'];
const CONTEXT_ID_LISTS = ['productIds', 'variantIds'];

function fail(): never {
  throw new InvalidArgumentError('Invalid chatbot request body');
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return fail();
  const trimmed = value.trim();
  const control = multiline ? CONTROL : CONTROL_NO_NEWLINE;
  if (!trimmed || trimmed.length > max || control.test(trimmed)) return fail();
  return trimmed;
}

function instant(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : null;
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value as string)
  ) {
    return fail();
  }
  return date;
}

function parseCustomer(value: unknown): BotEnvelope['customer'] {
  if (!isObject(value)) return fail();
  const { phoneCountryCode: cc, phone, displayName, ...rest } = value;
  if (Object.keys(rest).length > 0) return fail();
  if (displayName !== undefined) text(displayName, 100);
  if (typeof cc !== 'string' || typeof phone !== 'string') return fail();
  if (!canonicalPhone(cc, phone)) return fail();
  return { phoneCountryCode: cc, phone };
}

function parseContext(value: unknown): BotEnvelope['context'] {
  if (!isObject(value)) return fail();
  const out: Record<string, string | number | string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      CONTEXT_IDS.includes(key) &&
      typeof item === 'string' &&
      ID.test(item)
    ) {
      out[key] = item;
    } else if (
      CONTEXT_ID_LISTS.includes(key) &&
      Array.isArray(item) &&
      item.length <= 20 &&
      item.every((id) => typeof id === 'string' && ID.test(id))
    ) {
      out[key] = item as string[];
    } else if (
      key === 'quantity' &&
      Number.isInteger(item) &&
      (item as number) >= 0 &&
      (item as number) <= 100_000
    ) {
      out[key] = item as number;
    } else {
      return fail();
    }
  }
  return out;
}

export function parseBotEnvelope(body: unknown): BotEnvelope {
  if (!isObject(body)) return fail();
  if (Object.keys(body).some((key) => !KEYS.has(key))) return fail();

  const { sourceRequestId, subtype } = body;
  if (typeof sourceRequestId !== 'string' || !UUID.test(sourceRequestId)) {
    return fail();
  }
  const known: readonly string[] = [
    ...WRAPPED_SUBTYPES,
    ...DIRECT_SUBTYPES,
    ...DISABLED_SUBTYPES,
  ];
  if (typeof subtype !== 'string' || !known.includes(subtype)) return fail();
  const direct = (DIRECT_SUBTYPES as readonly string[]).includes(subtype);
  const wrapped = (WRAPPED_SUBTYPES as readonly string[]).includes(subtype);
  const optional = <T>(key: string, parse: (value: unknown) => T): T | null =>
    body[key] === undefined || body[key] === null ? null : parse(body[key]);
  const required = <T>(key: string, parse: (value: unknown) => T): T => {
    const value = optional(key, parse);
    return value === null ? fail() : value;
  };

  const customer = optional('customer', parseCustomer);
  const dedupKey = optional('dedupKey', (v) =>
    typeof v === 'string' && TOKEN.test(v) ? v : fail(),
  );
  // The dedup index and the limits are per customer (§3.5, §6.4).
  if (direct && !customer) return fail();
  if (dedupKey && !customer) return fail();

  let detail: Record<string, unknown> = {};
  if (wrapped) {
    if (!isObject(body.detail)) return fail();
    detail = body.detail;
  } else if (
    body.detail !== undefined &&
    !(isObject(body.detail) && Object.keys(body.detail).length === 0)
  ) {
    return fail();
  }

  return {
    sourceRequestId,
    subtype: subtype as EnvelopeSubtype,
    customer,
    conversationRef: direct
      ? required('conversationRef', (v) => text(v, 200))
      : optional('conversationRef', (v) => text(v, 200)),
    lastCustomerMessageAt: direct
      ? required('lastCustomerMessageAt', instant)
      : optional('lastCustomerMessageAt', instant),
    summary: direct
      ? required('summary', (v) => text(v, 140))
      : optional('summary', (v) => text(v, 140)),
    needs: optional('needs', (v) => text(v, 1000, true)),
    context: optional('context', parseContext),
    dedupKey,
    triggerWaMessageId: optional('triggerWaMessageId', (v) =>
      typeof v === 'string' && TOKEN.test(v) ? v : fail(),
    ),
    scheduledFor: optional('scheduledFor', instant),
    detail,
  };
}

/** Sorted-key JSON, so the hash ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The idempotency hash (§3.1): every parsed field that changes what the
 * request means. `displayName` is dropped by the parser, so renaming a
 * customer does not turn a retry into a conflict.
 */
export function botEnvelopeHash(envelope: BotEnvelope): string {
  return createHash('sha256').update(canonical(envelope), 'utf8').digest('hex');
}
