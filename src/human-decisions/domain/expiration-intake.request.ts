/**
 * HD-EXP-01a — EXPIRATION intake body parser and canonical identity.
 * Design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * Body = EXACTLY four required own keys `{sourceRequestId, type: EXPIRATION,
 * productId, variantId: UUID | null}`; extra keys (`metadata`, authority
 * fields, the internal `originalSourceRequestId`) are rejected, never stripped.
 * UUIDs follow HD-02a (v1-v8, trim+lowercase, nil rejected) with raw bytes
 * retained for the header match. Symbols, non-enumerables and accessors fail
 * without a getter; the wrapped boundary yields one fixed, value-free error.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

/** The only supported decision type for this intake body. */
export const EXPIRATION_TYPE = 'EXPIRATION';

/** Stable, value-free domain code for every EXPIRATION intake failure. */
export const INVALID_EXPIRATION_REQUEST_CODE = 'INVALID_EXPIRATION_REQUEST';

/** Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exact own-key allowlist for the four-key EXPIRATION intake body. */
const KEYS = ['sourceRequestId', 'type', 'productId', 'variantId'] as const;

/** Parsed command; `originalSourceRequestId` keeps raw bytes for header match. */
export interface ExpirationIntakeRequest {
  sourceRequestId: string;
  originalSourceRequestId: string;
  type: typeof EXPIRATION_TYPE;
  productId: string;
  variantId: string | null;
}

/** Canonical identity: EXACTLY the four normalized wire keys. */
export interface ExpirationIntakeIdentity {
  sourceRequestId: string;
  type: typeof EXPIRATION_TYPE;
  productId: string;
  variantId: string | null;
}

/** Value-free failure: one fixed message and code, never the rejected input. */
function fail(): never {
  throw new InvalidArgumentError(
    'Invalid expiration intake request',
    INVALID_EXPIRATION_REQUEST_CODE,
  );
}

/** Read one own ENUMERABLE DATA field without invoking a getter or `[[Get]]`. */
function readField(value: unknown, key: string): { readonly value: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    descriptor.enumerable !== true
  ) {
    fail();
  }
  return { value: descriptor.value };
}

/** Canonical lowercase UUID, trimmed like HD-02a; nil/invalid rejected. */
function canonicalUuid(value: unknown): string {
  if (typeof value !== 'string') {
    fail();
  }
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    fail();
  }
  return normalized;
}

/** Parse an untrusted body; the exported boundary sanitizes trap throws. */
function parseIntakeRequest(value: unknown): ExpirationIntakeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail();
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(KEYS as readonly string[]).includes(key)) {
      fail();
    }
  }

  const originalSourceRequestId = readField(value, 'sourceRequestId').value;
  if (typeof originalSourceRequestId !== 'string') {
    fail();
  }
  const sourceRequestId = canonicalUuid(originalSourceRequestId);
  if (readField(value, 'type').value !== EXPIRATION_TYPE) {
    fail();
  }
  const productId = canonicalUuid(readField(value, 'productId').value);
  const rawVariantId = readField(value, 'variantId').value;
  const variantId = rawVariantId === null ? null : canonicalUuid(rawVariantId);

  return {
    sourceRequestId,
    originalSourceRequestId,
    type: EXPIRATION_TYPE,
    productId,
    variantId,
  };
}

/**
 * Parse an untrusted body into the typed command; any thrown value becomes one
 * fresh, fixed, value-free error.
 */
export function parseExpirationIntakeRequest(
  value: unknown,
): ExpirationIntakeRequest {
  try {
    return parseIntakeRequest(value);
  } catch {
    fail();
  }
}

/**
 * Typed projection of an already-validated command onto the canonical four-key
 * identity (NOT a raw trust boundary); `originalSourceRequestId` is excluded.
 */
export function canonicalizeExpirationIntakeRequest(
  parsed: ExpirationIntakeRequest,
): ExpirationIntakeIdentity {
  return {
    productId: parsed.productId,
    sourceRequestId: parsed.sourceRequestId,
    type: parsed.type,
    variantId: parsed.variantId,
  };
}

/**
 * Deterministic SHA-256 over the canonical four-key identity; keys are built in
 * lexicographic order, so the byte form is replay-stable and order-independent.
 */
export function hashExpirationIntakeIdentity(
  identity: ExpirationIntakeIdentity,
): string {
  const canonical: Record<string, unknown> = {
    productId: identity.productId,
    sourceRequestId: identity.sourceRequestId,
    type: identity.type,
    variantId: identity.variantId,
  };

  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}
