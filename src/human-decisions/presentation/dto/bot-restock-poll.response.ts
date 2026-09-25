/**
 * DTO: BotRestockPollResponse — HD-05a1 bot `GET` poll projection.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Historical POST vs current GET"). This pure mapper is DB-FREE; HD-05b owns
 * the Prisma adapter, HD-05c the HTTP route and the application-outcome ACK.
 *
 * The bot poll consumes an exact discriminated projection of the CURRENT
 * decision state:
 *   * PENDING  -> `version:1`, `resolution:null`, `applyBefore:null`.
 *   * RESOLVED -> `version:2`, a typed non-null `resolution`, and
 *     `applyBefore = resolvedAt + 1 hour` as UTC ISO, for BOTH actions.
 *
 * The body is exactly ten top-level keys: `{id,sourceRequestId,type,status,
 * version,createdAt,snapshot,supersedesDecisionId,resolution,applyBefore}` and
 * the snapshot is exactly the nine immutable intake keys. The positive
 * resolution carries `restockDays`; the negative variant OMITS it entirely
 * (never `null`).
 *
 * Deliberately ABSENT (reviewer identity / authority / ACK / PII):
 * `resolvedBy`, `resolvedById`/`resolvedByActorId`/`resolvedByDisplayName`,
 * `source`, `tenantId`, `canonicalRequestHash`, `submittedCredentialId`,
 * `resolutionRequestId`, provider/ACK/outcome evidence and customer PII. The
 * domain read record has NO `source` field either: the Prisma adapter pins
 * `source`/`type`/tenant in the WHERE clause, so a caller can never widen this
 * projection by injecting one.
 *
 * FAIL CLOSED: the HD-01 DB `CHECK` pins the resolution/outcome coupling but
 * NOT the snapshot invariants, so this pure projection re-validates the
 * persisted row before projecting it, using the HD-02a policy: `type` must be
 * `RESTOCK`, `createdAt`/`resolvedAt` must be valid `Date`s, `id`,
 * `sourceRequestId`, `supersedesDecisionId`, `productId`/`variantId` must be
 * canonical RFC 4122 UUIDs (the nil UUID is rejected), `productName` must be
 * non-empty, NFC, whitespace-collapsed/trimmed, within the HD-02a cap and
 * C0/C1 control-free, `sku` must be null or NFC/trimmed/control-free,
 * `requestedQuantity` must be null or a positive safe integer,
 * `observedStockAtRequest` must be null or a non-negative safe integer, the
 * stock observation pair must be both null or a present count with a valid
 * `Date`, `branchId` must be non-blank and `branchName` must be
 * `string | null`. A malformed persisted row throws a VALUE-FREE `Error`
 * instead of publishing an invalid discriminant; malformed values are never
 * truncated or silently normalized, and a PENDING row never fabricates a
 * resolution. `resolvedAt + 1h` is bounds-checked so a date near the maximum
 * `Date` never escapes as a `RangeError`.
 */
import {
  HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE,
  HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE,
} from '../../domain/human-decision-review-resolve.repository';
import type {
  BotRestockPollRecord,
  BotRestockPollSnapshotRecord,
} from '../../domain/bot-restock-poll.repository';
import {
  RESTOCK_PRODUCT_NAME_MAX_LENGTH,
  RESTOCK_TYPE,
} from '../../domain/restock-request-canonicalizer';

/** Immutable sanitized snapshot projected by the bot poll. */
export interface BotRestockPollSnapshotResponse {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  /** Canonical UTC ISO string, or `null` when no observation was supplied. */
  stockObservedAt: string | null;
}

/**
 * Typed resolution union. The negative variant OMITS `restockDays` entirely
 * (never `null`) and neither variant carries reviewer identity.
 */
export type BotRestockPollResolutionResponse =
  | {
      action: typeof HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE;
      restockDays: number;
      resolvedAt: string;
    }
  | {
      action: typeof HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE;
      resolvedAt: string;
    };

/** Current PENDING decision: no resolution and no deadline yet. */
export interface BotRestockPollPendingResponse {
  id: string;
  sourceRequestId: string;
  type: typeof RESTOCK_TYPE;
  status: 'PENDING';
  version: 1;
  /** Canonical UTC ISO string. */
  createdAt: string;
  snapshot: BotRestockPollSnapshotResponse;
  supersedesDecisionId: string | null;
  resolution: null;
  applyBefore: null;
}

/** Current RESOLVED decision: typed resolution and its half-open hour deadline. */
export interface BotRestockPollResolvedResponse {
  id: string;
  sourceRequestId: string;
  type: typeof RESTOCK_TYPE;
  status: 'RESOLVED';
  version: 2;
  /** Canonical UTC ISO string. */
  createdAt: string;
  snapshot: BotRestockPollSnapshotResponse;
  supersedesDecisionId: string | null;
  resolution: BotRestockPollResolutionResponse;
  /** Canonical UTC ISO string: `resolvedAt + 1 hour`. */
  applyBefore: string;
}

export type BotRestockPollResponse =
  | BotRestockPollPendingResponse
  | BotRestockPollResolvedResponse;

const POSITIVE_ACTION = HUMAN_DECISION_RESOLUTION_PROVIDE_ESTIMATE;
const NEGATIVE_ACTION = HUMAN_DECISION_RESOLUTION_REPORT_UNAVAILABLE;
const MIN_RESTOCK_DAYS = 1;
const MAX_RESTOCK_DAYS = 365;
const APPLY_BEFORE_OFFSET_MS = 3_600_000;
/** Largest valid `Date` time value (`+275760-09-13T00:00:00.000Z`). */
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;

/** Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Runs of Unicode whitespace, mirroring the HD-02a canonicalizer policy. */
const WHITESPACE_RUN = /\s+/gu;

/** Value-free fail-closed guard: never echoes persisted values. */
function failClosed(): never {
  throw new Error('Malformed persisted bot restock poll state');
}

/** True when the string contains a C0/C1 control character (HD-02a policy). */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    failClosed();
  }
}

function assertNonBlankString(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failClosed();
  }
}

function assertValidOptionalBranchName(value: string | null): void {
  if (value === null) {
    return;
  }
  if (typeof value !== 'string') {
    failClosed();
  }
}

function assertValidProductName(value: string): void {
  if (typeof value !== 'string') {
    failClosed();
  }
  if (value.normalize('NFC') !== value) {
    failClosed();
  }
  if (hasControlCharacter(value)) {
    failClosed();
  }
  if (value.replace(WHITESPACE_RUN, ' ').trim() !== value) {
    failClosed();
  }
  if (value.length === 0 || value.length > RESTOCK_PRODUCT_NAME_MAX_LENGTH) {
    failClosed();
  }
}

function assertValidOptionalSku(value: string | null): void {
  if (value === null) {
    return;
  }
  if (typeof value !== 'string') {
    failClosed();
  }
  if (value.normalize('NFC') !== value) {
    failClosed();
  }
  if (hasControlCharacter(value)) {
    failClosed();
  }
  // HD-02a stores a blank sku as null, so a persisted blank is corruption.
  if (value.trim() !== value || value.trim().length === 0) {
    failClosed();
  }
}

function assertValidUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    failClosed();
  }
}

function assertValidOptionalUuid(value: string | null): void {
  if (value === null) {
    return;
  }
  assertValidUuid(value);
}

function assertPositiveSafeIntegerOrNull(value: number | null): void {
  if (value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    failClosed();
  }
}

function assertNonNegativeSafeIntegerOrNull(value: number | null): void {
  if (value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    failClosed();
  }
}

function assertStockObservationPair(
  observed: number | null,
  observedAt: Date | null,
): void {
  if (observed === null && observedAt === null) {
    return;
  }
  if (observed === null || observedAt === null) {
    failClosed();
  }
  assertValidDate(observedAt);
}

/** Validates the immutable intake snapshot re-read by the poll. */
function assertPollableSnapshot(snapshot: BotRestockPollSnapshotRecord): void {
  if (typeof snapshot !== 'object' || snapshot === null) {
    failClosed();
  }
  assertNonBlankString(snapshot.branchId);
  assertValidOptionalBranchName(snapshot.branchName);
  assertValidUuid(snapshot.productId);
  assertValidProductName(snapshot.productName);
  assertValidOptionalUuid(snapshot.variantId);
  assertValidOptionalSku(snapshot.sku);
  assertPositiveSafeIntegerOrNull(snapshot.requestedQuantity);
  assertNonNegativeSafeIntegerOrNull(snapshot.observedStockAtRequest);
  assertStockObservationPair(
    snapshot.observedStockAtRequest,
    snapshot.stockObservedAt,
  );
}

/** Validates the persisted row (type, dates, ids and snapshot) BEFORE projection. */
function assertPollableRecord(record: BotRestockPollRecord): void {
  if (typeof record !== 'object' || record === null) {
    failClosed();
  }
  if (record.type !== RESTOCK_TYPE) {
    failClosed();
  }
  assertValidUuid(record.id);
  assertValidUuid(record.sourceRequestId);
  assertValidOptionalUuid(record.supersedesDecisionId);
  assertValidDate(record.createdAt);
  assertPollableSnapshot(record.snapshot);
}

interface ValidatedResolution {
  response: BotRestockPollResolutionResponse;
  resolvedAt: Date;
}

/**
 * Validates the persisted resolution state and returns the typed resolution
 * plus its validated `Date`, or `null` for a well-formed PENDING row. Any
 * malformed state fails closed.
 */
function toResolution(
  record: BotRestockPollRecord,
): ValidatedResolution | null {
  if (record.status === 'PENDING') {
    if (
      record.version !== 1 ||
      record.resolutionAction !== null ||
      record.restockDays !== null ||
      record.resolvedAt !== null
    ) {
      failClosed();
    }
    return null;
  }

  if (record.status !== 'RESOLVED') {
    failClosed();
  }

  if (record.version !== 2 || record.resolvedAt === null) {
    failClosed();
  }
  assertValidDate(record.resolvedAt);

  const resolvedAt: string = record.resolvedAt.toISOString();

  if (record.resolutionAction === POSITIVE_ACTION) {
    if (
      record.restockDays === null ||
      !Number.isInteger(record.restockDays) ||
      record.restockDays < MIN_RESTOCK_DAYS ||
      record.restockDays > MAX_RESTOCK_DAYS
    ) {
      failClosed();
    }
    return {
      response: {
        action: POSITIVE_ACTION,
        restockDays: record.restockDays,
        resolvedAt,
      },
      resolvedAt: record.resolvedAt,
    };
  }

  if (record.resolutionAction === NEGATIVE_ACTION) {
    if (record.restockDays !== null) {
      failClosed();
    }
    return {
      response: { action: NEGATIVE_ACTION, resolvedAt },
      resolvedAt: record.resolvedAt,
    };
  }

  failClosed();
}

/**
 * `resolvedAt + 1h` as canonical UTC ISO. The shift is bounds-checked BEFORE
 * `toISOString`, so a resolved timestamp within an hour of the maximum `Date`
 * fails closed instead of throwing a `RangeError`.
 */
function toApplyBefore(resolvedAt: Date): string {
  const shifted = resolvedAt.getTime() + APPLY_BEFORE_OFFSET_MS;
  if (!Number.isSafeInteger(shifted) || shifted > MAX_DATE_TIME_MS) {
    failClosed();
  }
  return new Date(shifted).toISOString();
}

/** Fresh snapshot projection; the input object is never mutated. */
function toSnapshot(
  record: BotRestockPollRecord,
): BotRestockPollSnapshotResponse {
  return {
    branchId: record.snapshot.branchId,
    branchName: record.snapshot.branchName,
    productId: record.snapshot.productId,
    productName: record.snapshot.productName,
    variantId: record.snapshot.variantId,
    sku: record.snapshot.sku,
    requestedQuantity: record.snapshot.requestedQuantity,
    observedStockAtRequest: record.snapshot.observedStockAtRequest,
    stockObservedAt: record.snapshot.stockObservedAt
      ? record.snapshot.stockObservedAt.toISOString()
      : null,
  };
}

/**
 * Pure projection from a persisted decision to the bot poll DTO. Validates the
 * persisted record first, then builds the exact discriminated body without any
 * spread from the persisted row and without mutating the input. Throws a
 * value-free `Error` on a malformed persisted state.
 */
export function toBotRestockPollResponse(
  record: BotRestockPollRecord,
): BotRestockPollResponse {
  assertPollableRecord(record);
  const resolution = toResolution(record);
  const snapshot = toSnapshot(record);
  const createdAt = record.createdAt.toISOString();

  if (resolution === null) {
    return {
      id: record.id,
      sourceRequestId: record.sourceRequestId,
      type: RESTOCK_TYPE,
      status: 'PENDING',
      version: 1,
      createdAt,
      snapshot,
      supersedesDecisionId: record.supersedesDecisionId,
      resolution: null,
      applyBefore: null,
    };
  }

  const applyBefore = toApplyBefore(resolution.resolvedAt);

  return {
    id: record.id,
    sourceRequestId: record.sourceRequestId,
    type: RESTOCK_TYPE,
    status: 'RESOLVED',
    version: 2,
    createdAt,
    snapshot,
    supersedesDecisionId: record.supersedesDecisionId,
    resolution: resolution.response,
    applyBefore,
  };
}
