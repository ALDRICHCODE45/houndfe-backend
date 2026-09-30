/**
 * HD-04c1 — pure `POST /human-decisions/:id/resolve` body parser.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Resolution is an exact discriminated union, not a free-text fallback").
 *
 * The route body is EXACTLY one of two variants and nothing else:
 *   positive `{action:'PROVIDE_RESTOCK_ESTIMATE',restockDays,expectedVersion,resolutionRequestId}`
 *   negative `{action:'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',expectedVersion,resolutionRequestId}`
 *
 * Boundaries enforced here (transport contract, no DB/route dependency):
 *   - The own-key set must be EXACTLY the variant's four/three keys. Any
 *     unknown or authority key (`tenantId`, `reviewerId`, `resolvedAt`,
 *     `applyBefore`, `providerMessageId`, `outcome`, free text, actor, source,
 *     credential, audit, branch, ...) is rejected, never stripped. A missing
 *     key is rejected too.
 *   - The negative variant must NOT carry `restockDays` at all, not even as
 *     `null` or `undefined`; the positive variant always carries it.
 *   - `restockDays` is a NUMBER safe integer in the closed natural-day range
 *     `1..365`; strings are NOT coerced and zero/fractions/`NaN`/`Infinity`
 *     are rejected.
 *   - `expectedVersion` is a NUMBER positive safe integer `>= 1`. It is NOT
 *     hard-coded to 1: a well-formed but stale version must reach the
 *     version/CAS comparison (HD-04c2) and answer `409 VERSION_CONFLICT`
 *     instead of being misclassified as a malformed `400`.
 *   - `resolutionRequestId` follows the HD-02a UUID policy: an RFC 4122 v1-v8
 *     canonical UUID (variant 8/9/a/b), trimmed and lowercased, with the nil
 *     UUID and every invalid shape rejected.
 *
 * OWN-KEY INTEGRITY: exactness is enforced with `Reflect.ownKeys`, not
 * `Object.keys`, so a hidden SYMBOL or non-enumerable own property cannot
 * bypass the allowlist. Every required key must additionally be an own,
 * ENUMERABLE DATA property: an accessor/getter is rejected WITHOUT being
 * invoked, and required values are read from the property descriptor rather
 * than through `[[Get]]`, so a `get` trap can never supply a value. The whole
 * boundary is wrapped, so an unexpected Proxy `ownKeys`/
 * `getOwnPropertyDescriptor` trap throw — or even an `InvalidArgumentError`
 * thrown by a hostile trap with a foreign message/code — is REPLACED by a
 * fresh fixed error instead of leaking.
 *
 * LIMIT: this parser sees an already-parsed JS value. Duplicate JSON keys
 * (for example two `restockDays` members) cannot be detected after
 * `JSON.parse`; that is outside this parser boundary and no such claim is made.
 *
 * FAIL CLOSED, VALUE-FREE: every rejection throws `InvalidArgumentError` with
 * ONE fixed message and the stable `INVALID_RESOLVE_REQUEST_CODE`; no raw
 * value, UUID, version or PII is ever echoed. The route-scoped
 * `HumanDecisionHttpFilter` (HD-04d) maps the class to `400 VALIDATION_ERROR`.
 * Reviewer identity, tenant, source, credential, audit and branch data are
 * derived server-side by HD-04c2 and are deliberately NOT read from the body.
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import { normalizeExpirationText } from '../../domain/expiration-text';

/** Positive action code: a confirmed estimate of `restockDays` natural days. */
export const RESOLVE_PROVIDE_RESTOCK_ESTIMATE = 'PROVIDE_RESTOCK_ESTIMATE';

/** Negative action code: no confirmed ETA (not "will never be restocked"). */
export const RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE =
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';

/** Inclusive natural-day bounds for the positive estimate. */
export const RESOLVE_RESTOCK_DAYS_MIN = 1;
export const RESOLVE_RESTOCK_DAYS_MAX = 365;

/**
 * Stable, value-free domain code. The route-scoped filter maps the
 * `InvalidArgumentError` class to `400 VALIDATION_ERROR`; this code only tags
 * the server-side log and is never echoed to the client.
 */
export const INVALID_RESOLVE_REQUEST_CODE = 'INVALID_RESOLVE_REQUEST';

/** The only two accepted action discriminants. */
export type ResolveHumanDecisionAction =
  | typeof RESOLVE_PROVIDE_RESTOCK_ESTIMATE
  | typeof RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE;

/** Positive estimate variant: `restockDays` is a natural-day count 1..365. */
export interface ResolveProvideRestockEstimateRequest {
  action: typeof RESOLVE_PROVIDE_RESTOCK_ESTIMATE;
  restockDays: number;
  expectedVersion: number;
  resolutionRequestId: string;
}

/**
 * Negative variant. `restockDays` is deliberately ABSENT (never `null`),
 * matching the approved contract and the reviewer projection.
 */
export interface ResolveReportRestockEstimateUnavailableRequest {
  action: typeof RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE;
  expectedVersion: number;
  resolutionRequestId: string;
}

/** Exact, discriminated resolve body returned to HD-04c2. */
export type ResolveHumanDecisionRequest =
  | ResolveProvideRestockEstimateRequest
  | ResolveReportRestockEstimateUnavailableRequest;

/**
 * Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected.
 * Kept byte-identical to the HD-02a canonicalizer policy so both boundaries
 * accept exactly the same identities.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Exact own-key allowlists. Any extra key is rejected, so the negative
 * variant carrying `restockDays` (even `undefined`) fails the key-set check.
 */
const POSITIVE_KEYS = [
  'action',
  'restockDays',
  'expectedVersion',
  'resolutionRequestId',
] as const;
const NEGATIVE_KEYS = [
  'action',
  'expectedVersion',
  'resolutionRequestId',
] as const;

/** Value-free failure: one fixed message and code, never the rejected input. */
function fail(): never {
  throw new InvalidArgumentError(
    'Invalid human decision resolution request',
    INVALID_RESOLVE_REQUEST_CODE,
  );
}

/** Non-null, non-array object; every other JS type cannot be a JSON body. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one required field as an own, ENUMERABLE DATA property. Uses the own
 * property descriptor instead of `record[key]`, so an accessor/getter is
 * rejected without being invoked and a `[[Get]]` trap can never supply a value.
 * Returns `null` for a missing, accessor, or non-enumerable key.
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
 * Enforce the EXACT own-key set with `Reflect.ownKeys` (all own string AND
 * symbol keys, enumerable OR not) and copy each allowed key's own data value.
 * An extra key, a symbol key, a non-enumerable key or an accessor key yields
 * `null`; a mismatched count short-circuits first.
 */
function readExactDataFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> | null {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== allowed.length) {
    return null;
  }
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
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

/** `expectedVersion` is a positive safe integer; the value is never coerced. */
function readExpectedVersion(fields: Record<string, unknown>): number {
  const value = fields.expectedVersion;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail();
  }
  return value;
}

/** `restockDays` is a natural-day safe integer in `[1, 365]`; no coercion. */
function readRestockDays(fields: Record<string, unknown>): number {
  const value = fields.restockDays;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < RESOLVE_RESTOCK_DAYS_MIN ||
    value > RESOLVE_RESTOCK_DAYS_MAX
  ) {
    fail();
  }
  return value;
}

/** Canonical lowercase UUID, trimmed like HD-02a; nil/invalid rejected. */
function readResolutionRequestId(fields: Record<string, unknown>): string {
  const value = fields.resolutionRequestId;
  if (typeof value !== 'string') {
    fail();
  }
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    fail();
  }
  return normalized;
}

/** Untrusted-body parse; the exported boundary wraps unexpected trap throws. */
function parseResolveRequest(value: unknown): ResolveHumanDecisionRequest {
  if (!isRecord(value)) {
    fail();
  }

  const action = readOwnDataField(value, 'action');
  if (action === null) {
    fail();
  }

  if (action.value === RESOLVE_PROVIDE_RESTOCK_ESTIMATE) {
    const fields = readExactDataFields(value, POSITIVE_KEYS);
    if (fields === null) {
      fail();
    }
    return {
      action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
      restockDays: readRestockDays(fields),
      expectedVersion: readExpectedVersion(fields),
      resolutionRequestId: readResolutionRequestId(fields),
    };
  }

  if (action.value === RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE) {
    const fields = readExactDataFields(value, NEGATIVE_KEYS);
    if (fields === null) {
      fail();
    }
    return {
      action: RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
      expectedVersion: readExpectedVersion(fields),
      resolutionRequestId: readResolutionRequestId(fields),
    };
  }

  fail();
}

/**
 * Parse an untrusted resolve body into the exact discriminated union.
 *
 * Pure and non-mutating. The boundary is wrapped so ANY thrown value — an
 * unexpected Proxy `ownKeys`/`getOwnPropertyDescriptor` trap, an accessor, or
 * even an `InvalidArgumentError` thrown by a hostile trap with a foreign
 * message/code — is REPLACED by a fresh fixed, value-free `InvalidArgumentError`.
 * No raw exception, message or code is rethrown, attached or logged.
 */
export function parseResolveHumanDecisionRequest(
  value: unknown,
): ResolveHumanDecisionRequest {
  try {
    return parseResolveRequest(value);
  } catch {
    fail();
  }
}

// ---------------------------------------------------------------------------
// HD-EXP-02a — EXPIRATION resolution parser (foundation, UNWIRED).
// ---------------------------------------------------------------------------

/**
 * HD-EXP-02a — pure `expirationText` resolution parser (foundation, UNWIRED).
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md`.
 * The body is EXACTLY one of two variants and nothing else:
 *   positive `{action:'PROVIDE_EXPIRATION_TEXT',expirationText,expectedVersion,resolutionRequestId}`
 *   negative `{action:'REPORT_EXPIRATION_UNAVAILABLE',expectedVersion,resolutionRequestId}`
 *
 * This is a SEPARATE export from `parseResolveHumanDecisionRequest`, which the
 * RESTOCK controller/port still consume unchanged; widening the existing union
 * would force downstream RESTOCK types to change. `expirationText` reuses the
 * HD-EXP-01a `normalizeExpirationText` policy verbatim (NFC, C0/C1 reject,
 * whitespace collapse+trim, 1..500 UTF-16 units) — no duplicated policy.
 * `expectedVersion`, `resolutionRequestId` and the exact own-key/authority,
 * accessor, symbol and trap defenses mirror the RESTOCK boundary, so every
 * rejection is the SAME fixed value-free `InvalidArgumentError`.
 */

/** EXP positive action: a confirmed plain-text expiration answer. */
export const RESOLVE_PROVIDE_EXPIRATION_TEXT = 'PROVIDE_EXPIRATION_TEXT';

/** EXP negative action: the team could not confirm the expiration. */
export const RESOLVE_REPORT_EXPIRATION_UNAVAILABLE =
  'REPORT_EXPIRATION_UNAVAILABLE';

/** Positive EXP variant; `expirationText` is normalized to 1..500 units. */
export interface ResolveProvideExpirationTextRequest {
  action: typeof RESOLVE_PROVIDE_EXPIRATION_TEXT;
  expirationText: string;
  expectedVersion: number;
  resolutionRequestId: string;
}

/** Negative EXP variant; `expirationText` is deliberately ABSENT. */
export interface ResolveReportExpirationUnavailableRequest {
  action: typeof RESOLVE_REPORT_EXPIRATION_UNAVAILABLE;
  expectedVersion: number;
  resolutionRequestId: string;
}

/** Exact, discriminated EXPIRATION resolve body returned to the caller. */
export type ResolveExpirationHumanDecisionRequest =
  | ResolveProvideExpirationTextRequest
  | ResolveReportExpirationUnavailableRequest;

/** Exact own-key allowlists for the two EXP variants. */
const EXP_POSITIVE_KEYS = [
  'action',
  'expirationText',
  'expectedVersion',
  'resolutionRequestId',
] as const;
const EXP_NEGATIVE_KEYS = [
  'action',
  'expectedVersion',
  'resolutionRequestId',
] as const;

/** Reuses the HD-EXP-01a normalization/validation policy verbatim. */
function readExpirationText(fields: Record<string, unknown>): string {
  return normalizeExpirationText(fields.expirationText);
}

/** Untrusted EXP-body parse; the exported boundary wraps unexpected throws. */
function parseExpirationRequest(
  value: unknown,
): ResolveExpirationHumanDecisionRequest {
  if (!isRecord(value)) {
    fail();
  }

  const action = readOwnDataField(value, 'action');
  if (action === null) {
    fail();
  }

  if (action.value === RESOLVE_PROVIDE_EXPIRATION_TEXT) {
    const fields = readExactDataFields(value, EXP_POSITIVE_KEYS);
    if (fields === null) {
      fail();
    }
    return {
      action: RESOLVE_PROVIDE_EXPIRATION_TEXT,
      expirationText: readExpirationText(fields),
      expectedVersion: readExpectedVersion(fields),
      resolutionRequestId: readResolutionRequestId(fields),
    };
  }

  if (action.value === RESOLVE_REPORT_EXPIRATION_UNAVAILABLE) {
    const fields = readExactDataFields(value, EXP_NEGATIVE_KEYS);
    if (fields === null) {
      fail();
    }
    return {
      action: RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
      expectedVersion: readExpectedVersion(fields),
      resolutionRequestId: readResolutionRequestId(fields),
    };
  }

  fail();
}

/**
 * Parse an untrusted EXPIRATION resolve body into the exact discriminated EXP
 * union. Pure and non-mutating; UNWIRED (no controller/adapter calls it yet)
 * and it never widens or alters `parseResolveHumanDecisionRequest`. The
 * boundary is wrapped so ANY thrown value — including an
 * `InvalidArgumentError` from `normalizeExpirationText` — is REPLACED by the
 * same fixed, value-free `InvalidArgumentError` used by the RESTOCK parser.
 */
export function parseExpirationResolveHumanDecisionRequest(
  value: unknown,
): ResolveExpirationHumanDecisionRequest {
  try {
    return parseExpirationRequest(value);
  } catch {
    fail();
  }
}
