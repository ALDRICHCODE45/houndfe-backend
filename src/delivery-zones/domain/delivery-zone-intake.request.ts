/**
 * shipping-zones / T1 (S2) — bot DELIVERY_ZONE intake body parser and
 * canonical identity, in the exact-parser style of the EXPIRATION intake.
 *
 * Body = EXACTLY these own keys (extra keys are rejected, never stripped):
 *   sourceRequestId        UUID v1-v8, must equal `X-Idempotency-Key` (raw bytes)
 *   type                   'DELIVERY_ZONE'
 *   zipCode                5 digits
 *   state, municipality,   1..120 chars after NFC + whitespace collapse,
 *   neighborhood           no control characters
 *   phoneCountryCode       1..10 digits (no '+'), as in pricing/evaluate-cart
 *   phone                  1..20 digits
 *   conversationRef        1..200 chars, bot-owned conversation reference
 *   lastCustomerMessageAt  ISO-8601 UTC instant, not more than 5 min ahead of
 *                          the server clock
 * Every failure is one fixed, value-free InvalidArgumentError.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { isValidZipCode } from './delivery-zone.policy';

/** Wire/TS discriminator. Deliberately NOT a Prisma `HumanDecisionType`. */
export const DELIVERY_ZONE_TYPE = 'DELIVERY_ZONE';

/** Source of every bot requester row (same value as the RESTOCK intake). */
export const DELIVERY_ZONE_SOURCE = 'houndfe-chatbot';

export const INVALID_DELIVERY_ZONE_REQUEST_CODE =
  'INVALID_DELIVERY_ZONE_REQUEST';

const KEYS = [
  'sourceRequestId',
  'type',
  'zipCode',
  'state',
  'municipality',
  'neighborhood',
  'phoneCountryCode',
  'phone',
  'conversationRef',
  'lastCustomerMessageAt',
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const COUNTRY_CODE_PATTERN = /^[0-9]{1,10}$/;
const PHONE_PATTERN = /^[0-9]{1,20}$/;
const WHITESPACE_RUN = /\s+/gu;
const PLACE_MAX_LENGTH = 120;
const CONVERSATION_REF_MAX_LENGTH = 200;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface DeliveryZoneIntakeRequest {
  sourceRequestId: string;
  originalSourceRequestId: string;
  type: typeof DELIVERY_ZONE_TYPE;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  phoneCountryCode: string;
  phone: string;
  conversationRef: string;
  lastCustomerMessageAt: Date;
}

function fail(): never {
  throw new InvalidArgumentError(
    'Invalid delivery zone intake request',
    INVALID_DELIVERY_ZONE_REQUEST_CODE,
  );
}

/**
 * Copy the exact allowlisted own ENUMERABLE DATA fields into a plain record
 * without invoking a getter or Proxy `get` trap; anything else fails.
 */
function snapshotFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== KEYS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' || !(KEYS as readonly string[]).includes(key),
    )
  ) {
    fail();
  }
  const fields: Record<string, unknown> = {};
  for (const key of KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail();
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || hasControlCharacter(value)) {
    fail();
  }
  const normalized = value.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    fail();
  }
  return normalized;
}

function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail();
  }
  return value;
}

function parse(value: unknown, now: Date): DeliveryZoneIntakeRequest {
  const fields = snapshotFields(value);

  const originalSourceRequestId = fields.sourceRequestId;
  if (typeof originalSourceRequestId !== 'string') {
    fail();
  }
  const sourceRequestId = originalSourceRequestId.trim().toLowerCase();
  if (!UUID_PATTERN.test(sourceRequestId)) {
    fail();
  }
  if (fields.type !== DELIVERY_ZONE_TYPE) {
    fail();
  }
  const zipCode = fields.zipCode;
  if (!isValidZipCode(zipCode)) {
    fail();
  }
  const rawInstant = matching(
    fields.lastCustomerMessageAt,
    ISO_INSTANT_PATTERN,
  );
  const lastCustomerMessageAt = new Date(rawInstant);
  if (
    Number.isNaN(lastCustomerMessageAt.getTime()) ||
    lastCustomerMessageAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS
  ) {
    fail();
  }

  return {
    sourceRequestId,
    originalSourceRequestId,
    type: DELIVERY_ZONE_TYPE,
    zipCode,
    state: text(fields.state, PLACE_MAX_LENGTH),
    municipality: text(fields.municipality, PLACE_MAX_LENGTH),
    neighborhood: text(fields.neighborhood, PLACE_MAX_LENGTH),
    phoneCountryCode: matching(fields.phoneCountryCode, COUNTRY_CODE_PATTERN),
    phone: matching(fields.phone, PHONE_PATTERN),
    conversationRef: text(fields.conversationRef, CONVERSATION_REF_MAX_LENGTH),
    lastCustomerMessageAt,
  };
}

/** Parse an untrusted body; any thrown value becomes one fixed error. */
export function parseDeliveryZoneIntakeRequest(
  value: unknown,
  now: Date,
): DeliveryZoneIntakeRequest {
  try {
    return parse(value, now);
  } catch {
    return fail();
  }
}

/**
 * SHA-256 over the canonical normalized body (lexicographic keys). The raw
 * `originalSourceRequestId` and the rotating credential are excluded, so an
 * exact replay after credential rotation keeps the same identity.
 */
export function hashDeliveryZoneIntake(
  request: DeliveryZoneIntakeRequest,
): string {
  const canonical = {
    conversationRef: request.conversationRef,
    lastCustomerMessageAt: request.lastCustomerMessageAt.toISOString(),
    municipality: request.municipality,
    neighborhood: request.neighborhood,
    phone: request.phone,
    phoneCountryCode: request.phoneCountryCode,
    sourceRequestId: request.sourceRequestId,
    state: request.state,
    type: request.type,
    zipCode: request.zipCode,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}
