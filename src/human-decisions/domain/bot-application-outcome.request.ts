/**
 * HD-05b1 — pure `POST /chatbot-api/human-decisions/:id/application-outcome`
 * terminal ACK body parser and canonical evidence hash.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("ACK `{attemptId,expectedResolutionVersion,outcome,providerMessageId?,
 * providerAcceptedObservedAt?,attemptedAt?,evidenceCode?}` is one terminal
 * outcome per request: backend hashes the canonical allowlisted evidence,
 * exact replay of the same attempt ID/hash returns the same result").
 *
 * The route body is EXACTLY one of four variants and nothing else:
 *   `PROVIDER_ACCEPTED`      `{attemptId,expectedResolutionVersion,outcome,attemptedAt,providerMessageId,providerAcceptedObservedAt}`
 *   `PROVIDER_ACCEPTED_LATE` same six keys
 *   `DELIVERY_UNKNOWN`       `{attemptId,expectedResolutionVersion,outcome,attemptedAt,providerMessageId?}`
 *   `STALE`                  `{attemptId,expectedResolutionVersion,outcome}`
 *
 * Boundaries enforced here (transport contract, no DB/route/HTTP dependency):
 *   - The own-key set must be EXACTLY the variant's key set. Any unknown or
 *     authority key (`decisionId`, `tenantId`, `source`, `credentialId`,
 *     `ackReceivedAt`, `applyBefore`, `resolvedAt`, `actor`, free text, ...) is
 *     rejected, never stripped. A missing required key is rejected too.
 *   - `providerAcceptedObservedAt` is FORBIDDEN (even as `null`) for
 *     `DELIVERY_UNKNOWN` and `STALE`; `attemptedAt` and `providerMessageId` are
 *     FORBIDDEN (even as `null`) for `STALE`. `providerMessageId` on
 *     `DELIVERY_UNKNOWN` is audit-only and must be omitted, never `null`.
 *   - `evidenceCode` is ALWAYS forbidden (even as `null`): the wire has no
 *     approved evidence-code enum, so there is nothing to accept.
 *   - `expectedResolutionVersion` is a NUMBER positive safe integer. It is NOT
 *     hard-coded to 2: a well-formed but stale version must reach the
 *     version/CAS comparison and answer `409 VERSION_CONFLICT` instead of being
 *     misclassified as a malformed `400`.
 *   - `attemptId` follows the HD-02a UUID policy: an RFC 4122 v1-v8 canonical
 *     UUID (variant 8/9/a/b), trimmed and lowercased, with the nil UUID and
 *     every invalid shape rejected.
 *   - Every timestamp must already be canonical UTC
 *     `YYYY-MM-DDTHH:mm:ss.sssZ` with a real calendar day
 *     (`new Date(v).toISOString() === v`); `>=` offsets such as `+00:00`,
 *     missing milliseconds, leap-day rollover, timezone offsets and negative
 *     years are rejected. `providerAcceptedObservedAt >= attemptedAt` is the
 *     ONLY temporal relation checked here: it is structural (both values are in
 *     the body). The half-open resolution window (`resolvedAt <= t <
 *     applyBefore`) needs the PERSISTED decision and belongs to the future
 *     adapter, not to this pure parser.
 *   - `providerMessageId` must be a non-empty, already-NFC, already-trimmed,
 *     C0/DEL/C1-control-free string of at most 512 UTF-16 code units. A raw or
 *     non-canonical value is REJECTED, never truncated, whitespace-collapsed or
 *     Unicode-normalized on the caller's behalf.
 *
 * OWN-KEY INTEGRITY: exactness is enforced with `Reflect.ownKeys`, not
 * `Object.keys`, so a hidden SYMBOL or non-enumerable own property cannot
 * bypass the allowlist. Every read key must be an own, ENUMERABLE DATA
 * property: an accessor/getter is rejected WITHOUT being invoked, and values
 * are read from the property descriptor rather than through `[[Get]]`, so a
 * `get` trap can never supply a value. The whole boundary is wrapped, so an
 * unexpected Proxy `ownKeys`/`getOwnPropertyDescriptor` trap throw — or even an
 * `InvalidArgumentError` thrown by a hostile trap with a foreign message/code —
 * is REPLACED by a fresh fixed error instead of leaking.
 *
 * EVIDENCE HASH: the server derives the idempotency identity itself. A
 * client-supplied hash is never read or trusted. `hashBotApplicationOutcomeEvidence`
 * and `canonicalizeBotApplicationOutcomeEvidence` both accept `unknown` and
 * re-run this exact parser before projecting, because a static TypeScript type
 * is not a runtime guarantee: an unsafe direct caller handing raw JS fails
 * closed instead of hashing an attacker-shaped field set. The digest covers
 * exactly six lexicographically sorted keys as UTF-8 JSON —
 * `attemptId`, `attemptedAt`, `expectedResolutionVersion`, `outcome`,
 * `providerAcceptedObservedAt`, `providerMessageId` — where an omitted optional
 * value becomes `null` ONLY INSIDE the hash object, never on the typed wire
 * output. No `decisionId`, tenant, source, credential, `evidenceCode`, audit
 * timestamp (`ackReceivedAt`) or bot free text participates in the hash.
 *
 * LIMIT: this parser sees an already-parsed JS value. Duplicate JSON keys are
 * undetectable after `JSON.parse`; that is outside this boundary and no such
 * claim is made. The HTTP `200 {id,version,attemptId,outcome,ackReceivedAt}`
 * ACK response, the `409 IDEMPOTENCY_CONFLICT|OUTCOME_ALREADY_RECORDED|
 * VERSION_CONFLICT` mapping and the `NEEDS_RECONCILIATION` hold derived from
 * UNKNOWN/LATE are implemented later; none of them lives here.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

/** Definite provider acceptance observed inside the resolution window. */
export const PROVIDER_ACCEPTED = 'PROVIDER_ACCEPTED';
/** Definite provider acceptance observed at/after the deadline. */
export const PROVIDER_ACCEPTED_LATE = 'PROVIDER_ACCEPTED_LATE';
/** Ambiguous prior attempt; held for audited reconciliation. */
export const DELIVERY_UNKNOWN = 'DELIVERY_UNKNOWN';
/** No send could have occurred; the only outcome without `attemptedAt`. */
export const STALE = 'STALE';

/** The only four accepted outcome discriminants. */
export type BotApplicationOutcome =
  | typeof PROVIDER_ACCEPTED
  | typeof PROVIDER_ACCEPTED_LATE
  | typeof DELIVERY_UNKNOWN
  | typeof STALE;

/**
 * Stable, value-free domain code. A future route-scoped filter maps the
 * `InvalidArgumentError` class to `400 VALIDATION_ERROR`; this code only tags
 * the server-side log and is never echoed to the client.
 */
export const INVALID_OUTCOME_REQUEST_CODE = 'INVALID_OUTCOME_REQUEST';

/**
 * Maximum provider message ID length in UTF-16 code units. Longer IDs are
 * rejected, never truncated, so a surrogate pair is never split.
 */
export const PROVIDER_MESSAGE_ID_MAX_LENGTH = 512;

/** Fields shared by every variant. */
interface BotApplicationOutcomeRequestBase {
  /** Bot-stable attempt UUID; equals the ledger attempt identity. */
  attemptId: string;
  /** Positive safe integer; NOT hard-coded, so a stale version reaches CAS. */
  expectedResolutionVersion: number;
}

/** `PROVIDER_ACCEPTED`: definite acceptance observed before the deadline. */
export interface ProviderAcceptedRequest extends BotApplicationOutcomeRequestBase {
  outcome: typeof PROVIDER_ACCEPTED;
  attemptedAt: string;
  providerMessageId: string;
  providerAcceptedObservedAt: string;
}

/** `PROVIDER_ACCEPTED_LATE`: definite acceptance observed at/after deadline. */
export interface ProviderAcceptedLateRequest extends BotApplicationOutcomeRequestBase {
  outcome: typeof PROVIDER_ACCEPTED_LATE;
  attemptedAt: string;
  providerMessageId: string;
  providerAcceptedObservedAt: string;
}

/**
 * `DELIVERY_UNKNOWN`: ambiguous attempt. `attemptedAt` is required;
 * `providerMessageId` is audit-only and OPTIONAL (omitted, never `null`), and
 * `providerAcceptedObservedAt` is structurally impossible.
 */
export interface DeliveryUnknownRequest extends BotApplicationOutcomeRequestBase {
  outcome: typeof DELIVERY_UNKNOWN;
  attemptedAt: string;
  providerMessageId?: string;
}

/**
 * `STALE`: a definite no-send. It carries no send evidence at all, so all three
 * data keys are deliberately ABSENT (never `null`).
 */
export interface StaleRequest extends BotApplicationOutcomeRequestBase {
  outcome: typeof STALE;
}

/** Exact, discriminated terminal ACK body returned to the future adapter. */
export type BotApplicationOutcomeRequest =
  | ProviderAcceptedRequest
  | ProviderAcceptedLateRequest
  | DeliveryUnknownRequest
  | StaleRequest;

/**
 * Canonical six-key evidence snapshot. A `null` here means "omitted by the
 * variant" and exists ONLY for hashing; the typed wire command never carries
 * `null` and simply omits the key.
 */
export interface BotApplicationOutcomeEvidence {
  attemptId: string;
  attemptedAt: string | null;
  expectedResolutionVersion: number;
  outcome: BotApplicationOutcome;
  providerAcceptedObservedAt: string | null;
  providerMessageId: string | null;
}

/**
 * Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected.
 * Kept byte-identical to the HD-02a canonicalizer policy so both boundaries
 * accept exactly the same identities.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Canonical UTC instant: `YYYY-MM-DDTHH:mm:ss.sssZ`. Seconds and exactly three
 * fractional digits are mandatory, and the zone must be a literal `Z`; a
 * `±hh:mm` offset is rejected rather than normalized. Calendar validity is
 * proven afterwards by the `toISOString()` round-trip.
 */
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Exact own-key allowlists, per variant. */
const ACCEPTED_KEYS = [
  'attemptId',
  'attemptedAt',
  'expectedResolutionVersion',
  'outcome',
  'providerAcceptedObservedAt',
  'providerMessageId',
] as const;
const DELIVERY_UNKNOWN_KEYS = [
  'attemptId',
  'attemptedAt',
  'expectedResolutionVersion',
  'outcome',
  'providerMessageId',
] as const;
const STALE_KEYS = [
  'attemptId',
  'expectedResolutionVersion',
  'outcome',
] as const;

/** Value-free failure: one fixed message and code, never the rejected input. */
function fail(): never {
  throw new InvalidArgumentError(
    'Invalid bot application outcome request',
    INVALID_OUTCOME_REQUEST_CODE,
  );
}

/** Non-null, non-array object; every other JS type cannot be a JSON body. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the string contains a C0, DEL or C1 control character. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Read one field as an own, ENUMERABLE DATA property. Uses the own property
 * descriptor instead of `record[key]`, so an accessor/getter is rejected
 * without being invoked and a `[[Get]]` trap can never supply a value. Returns
 * `null` for a missing, accessor, or non-enumerable key.
 */
function readOwnDataField(
  record: Record<string, unknown>,
  key: string,
): { readonly value: unknown } | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    descriptor.enumerable !== true
  ) {
    return null;
  }
  return { value: descriptor.value };
}

/**
 * Enforce that EVERY own key (string or symbol, enumerable or not) is one of
 * `allowed`, and copy each allowed key's own data value. An extra key, a symbol
 * key, a non-enumerable key or an accessor key yields `null`. Missing allowed
 * keys are simply absent from the returned record and are checked per variant,
 * so `providerMessageId` can stay optional.
 */
function readAllowedOwnFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      return null;
    }
    const field = readOwnDataField(record, key);
    if (field === null) {
      return null;
    }
    fields[key] = field.value;
  }
  return fields;
}

/** Fail closed unless the variant supplied `key` as an own key. */
function requireOwnField(fields: Record<string, unknown>, key: string): void {
  if (!Object.prototype.hasOwnProperty.call(fields, key)) {
    fail();
  }
}

/** Read a required string; any non-string (including `null`) fails closed. */
function readRequiredString(
  fields: Record<string, unknown>,
  key: string,
): string {
  requireOwnField(fields, key);
  const value = fields[key];
  if (typeof value !== 'string') {
    fail();
  }
  return value;
}

/** Read a key the variant FORBIDS: it must be absent, not `null`/`undefined`. */
function assertAbsentField(fields: Record<string, unknown>, key: string): void {
  if (Object.prototype.hasOwnProperty.call(fields, key)) {
    fail();
  }
}

/** `expectedResolutionVersion` is a positive safe integer; never coerced. */
function readExpectedResolutionVersion(
  fields: Record<string, unknown>,
): number {
  requireOwnField(fields, 'expectedResolutionVersion');
  const value = fields.expectedResolutionVersion;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail();
  }
  return value;
}

/** Canonical lowercase UUID, trimmed like HD-02a; nil/invalid rejected. */
function readAttemptId(fields: Record<string, unknown>): string {
  const value = readRequiredString(fields, 'attemptId');
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    fail();
  }
  return normalized;
}

/**
 * Strict canonical UTC timestamp. The regex enforces the exact
 * `YYYY-MM-DDTHH:mm:ss.sssZ` shape (no offset, no missing milliseconds), and
 * the `toISOString()` round-trip proves the instant is real: a rollover such as
 * `2026-02-30` or `2026-06-31` cannot slip through. The returned string is the
 * input itself, so canonical values are never rewritten.
 */
function readCanonicalUtcTimestamp(
  fields: Record<string, unknown>,
  key: string,
): string {
  const raw = readRequiredString(fields, key);
  if (!CANONICAL_UTC_PATTERN.test(raw)) {
    fail();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) {
    fail();
  }
  return raw;
}

/**
 * `providerMessageId` must ALREADY be canonical: non-empty, NFC, trimmed, of at
 * most 512 UTF-16 code units and free of C0/DEL/C1 controls. A raw value is
 * rejected, never silently truncated or Unicode-normalized, so the hash always
 * covers the exact bytes the bot sent.
 */
function readProviderMessageId(
  fields: Record<string, unknown>,
  key: string,
): string {
  const value = readRequiredString(fields, key);
  if (hasControlCharacter(value)) {
    fail();
  }
  if (value.normalize('NFC') !== value) {
    fail();
  }
  if (value.trim() !== value || value.length === 0) {
    fail();
  }
  if (value.length > PROVIDER_MESSAGE_ID_MAX_LENGTH) {
    fail();
  }
  return value;
}

/** Read the discriminant from an own data property; no `[[Get]]` is performed. */
function readOutcome(record: Record<string, unknown>): BotApplicationOutcome {
  const field = readOwnDataField(record, 'outcome');
  if (field === null) {
    fail();
  }
  const value = field.value;
  if (
    value === PROVIDER_ACCEPTED ||
    value === PROVIDER_ACCEPTED_LATE ||
    value === DELIVERY_UNKNOWN ||
    value === STALE
  ) {
    return value;
  }
  fail();
}

/** Parse an untrusted ACK body; the exported boundary sanitizes trap throws. */
function parseOutcomeRequest(value: unknown): BotApplicationOutcomeRequest {
  if (!isRecord(value)) {
    fail();
  }

  const outcome = readOutcome(value);

  if (outcome === PROVIDER_ACCEPTED || outcome === PROVIDER_ACCEPTED_LATE) {
    const fields = readAllowedOwnFields(value, ACCEPTED_KEYS);
    if (fields === null) {
      fail();
    }
    const attemptedAt = readCanonicalUtcTimestamp(fields, 'attemptedAt');
    const providerAcceptedObservedAt = readCanonicalUtcTimestamp(
      fields,
      'providerAcceptedObservedAt',
    );
    if (
      new Date(providerAcceptedObservedAt).getTime() <
      new Date(attemptedAt).getTime()
    ) {
      fail();
    }
    return {
      attemptId: readAttemptId(fields),
      expectedResolutionVersion: readExpectedResolutionVersion(fields),
      outcome,
      attemptedAt,
      providerMessageId: readProviderMessageId(fields, 'providerMessageId'),
      providerAcceptedObservedAt,
    };
  }

  if (outcome === DELIVERY_UNKNOWN) {
    const fields = readAllowedOwnFields(value, DELIVERY_UNKNOWN_KEYS);
    if (fields === null) {
      fail();
    }
    assertAbsentField(fields, 'providerAcceptedObservedAt');
    const request: DeliveryUnknownRequest = {
      attemptId: readAttemptId(fields),
      expectedResolutionVersion: readExpectedResolutionVersion(fields),
      outcome: DELIVERY_UNKNOWN,
      attemptedAt: readCanonicalUtcTimestamp(fields, 'attemptedAt'),
    };
    if (Object.prototype.hasOwnProperty.call(fields, 'providerMessageId')) {
      request.providerMessageId = readProviderMessageId(
        fields,
        'providerMessageId',
      );
    }
    return request;
  }

  const fields = readAllowedOwnFields(value, STALE_KEYS);
  if (fields === null) {
    fail();
  }
  assertAbsentField(fields, 'attemptedAt');
  assertAbsentField(fields, 'providerMessageId');
  assertAbsentField(fields, 'providerAcceptedObservedAt');
  return {
    attemptId: readAttemptId(fields),
    expectedResolutionVersion: readExpectedResolutionVersion(fields),
    outcome: STALE,
  };
}

/**
 * Parse an untrusted ACK body into the exact discriminated union.
 *
 * Pure and non-mutating. The boundary is wrapped so ANY thrown value — an
 * unexpected Proxy `ownKeys`/`getOwnPropertyDescriptor` trap, an accessor, or
 * even an `InvalidArgumentError` thrown by a hostile trap with a foreign
 * message/code — is REPLACED by a fresh fixed, value-free `InvalidArgumentError`.
 * No raw exception, message or code is rethrown, attached or logged.
 */
export function parseBotApplicationOutcomeRequest(
  value: unknown,
): BotApplicationOutcomeRequest {
  try {
    return parseOutcomeRequest(value);
  } catch {
    fail();
  }
}

/**
 * Project an UNTRUSTED value onto the canonical six-key evidence object.
 *
 * The parameter is deliberately `unknown`, not `BotApplicationOutcomeRequest`:
 * a static type is not a runtime guarantee, and a future adapter can hand raw
 * JS here. The value is therefore re-parsed with
 * `parseBotApplicationOutcomeRequest` FIRST, so an injected own key
 * (`evidenceCode`, `actor`, `source`, ...), a forbidden-but-present evidence
 * key (`attemptedAt` on STALE, `providerAcceptedObservedAt` on
 * DELIVERY_UNKNOWN), an accessor, a symbol/non-enumerable extra or a hostile
 * Proxy trap all fail closed with the same fixed, value-free
 * `InvalidArgumentError` instead of being silently dropped from the hash.
 *
 * Omitted optional values become `null` ONLY here, so the hash stays total
 * while the typed wire output never carries `null`. Already-parsed input
 * remains valid: it is re-validated and projects to the identical object, so
 * every golden digest is unchanged.
 */
export function canonicalizeBotApplicationOutcomeEvidence(
  input: unknown,
): BotApplicationOutcomeEvidence {
  const parsed = parseBotApplicationOutcomeRequest(input);

  // Keys are inserted in lexicographic order (`attemptId`, `attemptedAt`,
  // `expectedResolutionVersion`, `outcome`, `providerAcceptedObservedAt`,
  // `providerMessageId`) so the projected object is itself a canonical byte
  // form, independent of the input object's own key order.
  if (parsed.outcome === DELIVERY_UNKNOWN) {
    return {
      attemptId: parsed.attemptId,
      attemptedAt: parsed.attemptedAt,
      expectedResolutionVersion: parsed.expectedResolutionVersion,
      outcome: parsed.outcome,
      providerAcceptedObservedAt: null,
      providerMessageId: parsed.providerMessageId ?? null,
    };
  }

  if (parsed.outcome === STALE) {
    return {
      attemptId: parsed.attemptId,
      attemptedAt: null,
      expectedResolutionVersion: parsed.expectedResolutionVersion,
      outcome: parsed.outcome,
      providerAcceptedObservedAt: null,
      providerMessageId: null,
    };
  }

  return {
    attemptId: parsed.attemptId,
    attemptedAt: parsed.attemptedAt,
    expectedResolutionVersion: parsed.expectedResolutionVersion,
    outcome: parsed.outcome,
    providerAcceptedObservedAt: parsed.providerAcceptedObservedAt,
    providerMessageId: parsed.providerMessageId,
  };
}

/** Serialize an object with lexicographically sorted keys for a stable byte form. */
function stableJson(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Deterministic SHA-256 (lowercase hex) over the canonical allowlist as UTF-8
 * JSON with lexicographically sorted keys. Order-independent by construction:
 * the input object's own insertion order can never change the digest, so an
 * exact replay of the same attempt produces the same hash and a changed payload
 * produces a different one.
 *
 * The boundary re-validates through `canonicalizeBotApplicationOutcomeEvidence`,
 * so this helper accepts `unknown` and NEVER trusts a caller's static type or a
 * client-provided hash: an out-of-contract or raw value fails closed with the
 * fixed `InvalidArgumentError` rather than hashing an attacker-shaped field
 * set. This helper is the only hash authority for the ACK path.
 */
export function hashBotApplicationOutcomeEvidence(input: unknown): string {
  const canonical = canonicalizeBotApplicationOutcomeEvidence(input);
  // Insertion order here already mirrors the lexicographic key order; `stableJson`
  // re-sorts so the digest can never depend on this literal's order.
  const evidence: Record<string, string | number | null> = {
    attemptId: canonical.attemptId,
    attemptedAt: canonical.attemptedAt,
    expectedResolutionVersion: canonical.expectedResolutionVersion,
    outcome: canonical.outcome,
    providerAcceptedObservedAt: canonical.providerAcceptedObservedAt,
    providerMessageId: canonical.providerMessageId,
  };

  return createHash('sha256')
    .update(stableJson(evidence), 'utf8')
    .digest('hex');
}
