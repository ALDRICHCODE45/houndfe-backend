/**
 * HD-02a — pure RESTOCK intake canonicalization and deterministic request hash.
 *
 * Approved design (read-only): `houndfe-chatbot-human-decisions`
 * `docs/human-decisions-contract-v1.md`. No DB/route/schema/provider dependency.
 *
 * Canonical allowlist (exactly these fields, alphabetically hashed as UTF-8
 * JSON): tenantId, source, sourceRequestId, type, productId,
 * normalizedProductName, variantId, sku, requestedQuantity,
 * observedStockAtRequest, stockObservedAt, supersedesDecisionId. `source` and
 * `type` are fixed server-side; `submittedCredentialId` is audit-only and
 * OUTSIDE the hash so credential rotation cannot change the idempotent
 * identity, and `branchId`/`branchName`/`createdAt` server projections are
 * excluded.
 *
 * `productId`, `variantId` and the bot identity UUIDs are validated as real
 * canonical RFC 4122 UUIDs; `stockObservedAt` is a strict ISO 8601 timestamp
 * (calendar-day and timezone-offset checked) normalized to canonical UTC.
 */
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const RESTOCK_SOURCE = 'houndfe-chatbot';
export const RESTOCK_TYPE = 'RESTOCK';

/**
 * Maximum product-name length in UTF-16 code units (bot peer approved). Longer
 * names are rejected, never truncated, so a surrogate pair is never split.
 */
export const RESTOCK_PRODUCT_NAME_MAX_LENGTH = 200;

/** Stable domain code for every RESTOCK intake validation failure. */
export const INVALID_RESTOCK_REQUEST_CODE = 'INVALID_RESTOCK_REQUEST';

/** Runs of Unicode whitespace (spaces, NBSP, line/paragraph separators, ...). */
const WHITESPACE_RUN = /\s+/gu;
/** Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * Strict ISO 8601 calendar timestamp: `YYYY-MM-DDTHH:MM:SS[.sss](Z|±hh:mm)`.
 * `.sss` is 1-3 fractional digits (ordinary milliseconds); the zone is `Z` or
 * an explicit `±hh:mm` offset. Component ranges are validated in code, so a
 * `Date.parse` rollover (e.g. `2026-02-30`) can never slip through.
 */
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface RestockRequestInput {
  /** Trusted caller value (ServiceAuthGuard tenant), never body-supplied. */
  tenantId: string;
  /** Bot's stable UUID; equals `X-Idempotency-Key` on the intake route. */
  sourceRequestId: string;
  productId: string;
  productName: string;
  variantId?: string | null;
  sku?: string | null;
  requestedQuantity?: number | null;
  observedStockAtRequest?: number | null;
  stockObservedAt?: string | Date | null;
  supersedesDecisionId?: string | null;
  /** Audit-only; excluded from the hash but returned for persistence. */
  submittedCredentialId: string;
}

export interface NormalizedRestockRequest {
  tenantId: string;
  source: typeof RESTOCK_SOURCE;
  sourceRequestId: string;
  type: typeof RESTOCK_TYPE;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  /** Canonical UTC ISO string. */
  stockObservedAt: string | null;
  supersedesDecisionId: string | null;
  submittedCredentialId: string;
}

export interface CanonicalRestockRequest {
  request: NormalizedRestockRequest;
  requestHash: string;
}

/** Throw a value-free validation error: never echo the raw input. */
function invalid(message: string): never {
  throw new InvalidArgumentError(message, INVALID_RESTOCK_REQUEST_CODE);
}

/** True when the string contains a C0/C1 control character (tab, newline, ...). */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} must be a non-blank string`);
  }
  return value;
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    invalid(`${field} must be a valid UUID`);
  }
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    invalid(`${field} must be a valid UUID`);
  }
  return normalized;
}

function normalizeOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeUuid(value, field);
}

/**
 * SKU has no numeric cap (`Product.sku`/`Variant.sku` are TEXT and the create
 * DTO sets no max length), so only NFC, trim, blank->null and C0/C1 controls
 * are enforced here.
 */
function normalizeOptionalSku(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    invalid('sku must be a string or null');
  }
  const normalized = value.normalize('NFC');
  if (hasControlCharacter(normalized)) {
    invalid('sku must not contain control characters');
  }
  const trimmed = normalized.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizePositiveInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field} must be a positive safe integer or null`);
  }
  return value;
}

function normalizeNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1];
}

function normalizeStockObservedAt(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      invalid('stockObservedAt must be a valid ISO timestamp or null');
    }
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    invalid('stockObservedAt must be a valid ISO timestamp or null');
  }

  const match = ISO_DATETIME_PATTERN.exec(value);
  if (!match) {
    invalid('stockObservedAt must be a valid ISO timestamp with Z or ±hh:mm');
  }
  const [
    ,
    yearStr,
    monthStr,
    dayStr,
    hourStr,
    minuteStr,
    secondStr,
    frac,
    zone,
  ] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  const millisecond = frac ? Number(frac.padEnd(3, '0')) : 0;

  if (month < 1 || month > 12) {
    invalid('stockObservedAt month is out of range');
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    invalid('stockObservedAt day is out of range');
  }
  if (hour > 23 || minute > 59 || second > 59) {
    invalid('stockObservedAt time is out of range');
  }

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMin = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMin > 59) {
      invalid('stockObservedAt offset is out of range');
    }
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMin);
  }

  // Build from validated components (not Date.parse) and apply the offset.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return new Date(date.getTime() - offsetMinutes * 60_000).toISOString();
}

function normalizeProductName(value: unknown): string {
  if (typeof value !== 'string') {
    invalid('productName must be a non-empty string');
  }
  const decomposed = value.normalize('NFC');
  if (hasControlCharacter(decomposed)) {
    invalid('productName must not contain control characters');
  }
  const collapsed = decomposed.replace(WHITESPACE_RUN, ' ').trim();
  if (collapsed.length === 0) {
    invalid('productName must be a non-empty string');
  }
  if (collapsed.length > RESTOCK_PRODUCT_NAME_MAX_LENGTH) {
    invalid(
      `productName exceeds the maximum length of ${RESTOCK_PRODUCT_NAME_MAX_LENGTH} characters`,
    );
  }
  return collapsed;
}

/**
 * Validate and normalize an intake payload into the immutable snapshot.
 * Nullable fields are individually validated; `observedStockAtRequest` and
 * `stockObservedAt` must be both present or both absent.
 */
export function normalizeRestockRequest(
  input: RestockRequestInput,
): NormalizedRestockRequest {
  const tenantId = requireNonBlankString(input?.tenantId, 'tenantId');
  const sourceRequestId = normalizeUuid(
    input?.sourceRequestId,
    'sourceRequestId',
  );
  const productId = normalizeUuid(input?.productId, 'productId');
  const productName = normalizeProductName(input?.productName);
  const variantId = normalizeOptionalUuid(input?.variantId, 'variantId');
  const sku = normalizeOptionalSku(input?.sku);
  const requestedQuantity = normalizePositiveInteger(
    input?.requestedQuantity,
    'requestedQuantity',
  );
  const observedStockAtRequest = normalizeNonNegativeInteger(
    input?.observedStockAtRequest,
    'observedStockAtRequest',
  );
  const stockObservedAt = normalizeStockObservedAt(input?.stockObservedAt);
  const supersedesDecisionId =
    input?.supersedesDecisionId === undefined ||
    input?.supersedesDecisionId === null
      ? null
      : normalizeUuid(input.supersedesDecisionId, 'supersedesDecisionId');
  const submittedCredentialId = requireNonBlankString(
    input?.submittedCredentialId,
    'submittedCredentialId',
  );

  if ((observedStockAtRequest === null) !== (stockObservedAt === null)) {
    invalid(
      'observedStockAtRequest and stockObservedAt must be provided together or omitted together',
    );
  }

  return {
    tenantId,
    source: RESTOCK_SOURCE,
    sourceRequestId,
    type: RESTOCK_TYPE,
    productId,
    productName,
    variantId,
    sku,
    requestedQuantity,
    observedStockAtRequest,
    stockObservedAt,
    supersedesDecisionId,
    submittedCredentialId,
  };
}

/** Serialize an object with alphabetically sorted keys for a stable byte form. */
function stableJson(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Deterministic SHA-256 over the canonical allowlist as UTF-8 JSON with
 * alphabetically sorted keys. The `submittedCredentialId` is intentionally
 * excluded: credential rotation must not change the idempotent identity.
 */
export function computeRestockRequestHash(
  request: NormalizedRestockRequest,
): string {
  const canonical: Record<string, unknown> = {
    tenantId: request.tenantId,
    source: request.source,
    sourceRequestId: request.sourceRequestId,
    type: request.type,
    productId: request.productId,
    normalizedProductName: request.productName,
    variantId: request.variantId,
    sku: request.sku,
    requestedQuantity: request.requestedQuantity,
    observedStockAtRequest: request.observedStockAtRequest,
    stockObservedAt: request.stockObservedAt,
    supersedesDecisionId: request.supersedesDecisionId,
  };

  return createHash('sha256')
    .update(stableJson(canonical), 'utf8')
    .digest('hex');
}

/** Validate, normalize and hash an intake payload in one pure call. */
export function canonicalizeRestockRequest(
  input: RestockRequestInput,
): CanonicalRestockRequest {
  const request = normalizeRestockRequest(input);
  return { request, requestHash: computeRestockRequestHash(request) };
}
