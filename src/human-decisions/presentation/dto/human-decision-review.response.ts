/**
 * DTO: HumanDecisionReviewResponse — HD-04b1 human reviewer projection.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * The POS human reviewer consumes an exact discriminated projection:
 *   * PENDING  -> `version:1`, `resolution:null`, `allowedActions` = the two
 *     RESTOCK codes (when the caller may resolve) or `[]` (read-only).
 *   * RESOLVED -> `version:2`, a typed non-null `resolution`, `allowedActions:[]`.
 *
 * `allowedActions` is a capability hint derived from the caller's
 * `update:HumanDecision` permission (`canResolve`); it NEVER grants authority by
 * itself. The only accepted values are the empty array or the exact ordered pair
 * `['PROVIDE_RESTOCK_ESTIMATE','REPORT_RESTOCK_ESTIMATE_UNAVAILABLE']`, and a
 * fresh array is returned on every call.
 *
 * The reviewer identity comes from the immutable `resolvedByActorId` /
 * `resolvedByDisplayName` snapshots pinned by the HD-01 `CHECK`, never from the
 * mutable `resolvedById` relation: the reviewer stays readable after a User
 * deletion nulls that FK.
 *
 * Deliberately ABSENT (bot-only / authority / PII): `sourceRequestId`,
 * `supersedesDecisionId`, `applyBefore`, `source`, `tenantId`,
 * `canonicalRequestHash`, `submittedCredentialId`, provider/outcome/evidence
 * columns, audit/reason, customer PII, raw transcripts or HTML/JSON. The
 * `title`/`sanitizedSummary` are server-owned fixed plain-text phrases and
 * never interpolate the (already sanitized) persisted `productName`.
 *
 * FAIL CLOSED: the HD-01 DB `CHECK` pins the resolution/outcome coupling but
 * NOT the intake snapshot invariants, so this pure projection re-validates the
 * persisted snapshot before projecting it, using the HD-02a policy: `type` must
 * be `RESTOCK`, `createdAt`/`resolvedAt` must be valid `Date`s, `productId`/
 * `variantId` must be canonical RFC 4122 UUIDs, `productName` must be non-empty,
 * NFC, whitespace-collapsed/trimmed, within the HD-02a cap and C0/C1
 * control-free, `sku` must be null or NFC/trimmed/control-free, `requestedQuantity`
 * must be null or a positive safe integer, `observedStockAtRequest` must be null
 * or a non-negative safe integer, the stock observation pair must be both null
 * or a present count with a valid `Date`, and resolved reviewer snapshots must
 * be non-blank. A corrupted persisted row throws a VALUE-FREE `Error` instead of
 * publishing an invalid discriminant; malformed values are never truncated or
 * silently normalized, and a PENDING row never fabricates a resolution.
 */
import {
  RESTOCK_PRODUCT_NAME_MAX_LENGTH,
  RESTOCK_TYPE,
} from '../../domain/restock-request-canonicalizer';

/**
 * Persisted row shape consumed by the mapper. Structurally compatible with a
 * selected Prisma `HumanDecision` row (the wider `string`/`string|null` enums
 * accept the generated enum values); the mapper re-validates at runtime because
 * a persisted row must never be trusted blindly.
 */
export interface HumanDecisionReviewRecord {
  id: string;
  type: string;
  status: string;
  version: number;
  createdAt: Date;
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: Date | null;
  resolutionAction: string | null;
  restockDays: number | null;
  resolvedAt: Date | null;
  resolvedByActorId: string | null;
  resolvedByDisplayName: string | null;
}

/**
 * The only two pending action values, in the exact FE contract order. Exported
 * as a `readonly` tuple so consumers can rely on the order; the mapper copies it
 * per call because the response type is a mutable tuple.
 */
const PENDING_ALLOWED_ACTIONS = [
  'PROVIDE_RESTOCK_ESTIMATE',
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
] as const;

/** One exact RESTOCK reviewer action code. */
export type HumanDecisionReviewAction =
  (typeof PENDING_ALLOWED_ACTIONS)[number];

/**
 * Exact pending action contract: either no actions (read-only reviewer) or the
 * two RESTOCK codes in the fixed order. A partial or reordered array does not
 * type-check.
 */
export type HumanDecisionReviewPendingActions =
  | []
  | [(typeof PENDING_ALLOWED_ACTIONS)[0], (typeof PENDING_ALLOWED_ACTIONS)[1]];

/** Immutable sanitized snapshot projected to the reviewer. */
export interface HumanDecisionReviewSnapshotResponse {
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

/** Durable reviewer identity projected from the immutable snapshots. */
export interface HumanDecisionReviewResolvedByResponse {
  id: string;
  displayName: string;
}

/**
 * Typed resolution union. The negative variant OMITS `restockDays` entirely
 * (never `null`), matching the approved contract that forbids a days field.
 */
export type HumanDecisionReviewResolutionResponse =
  | {
      action: 'PROVIDE_RESTOCK_ESTIMATE';
      restockDays: number;
      resolvedAt: string;
      resolvedBy: HumanDecisionReviewResolvedByResponse;
    }
  | {
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';
      resolvedAt: string;
      resolvedBy: HumanDecisionReviewResolvedByResponse;
    };

interface HumanDecisionReviewBaseResponse {
  id: string;
  type: typeof RESTOCK_TYPE;
  title: string;
  sanitizedSummary: string;
  /** Canonical UTC ISO string. */
  createdAt: string;
  snapshot: HumanDecisionReviewSnapshotResponse;
}

/** PENDING decision: no resolution, version 1, capability-derived actions. */
export interface HumanDecisionReviewPendingResponse extends HumanDecisionReviewBaseResponse {
  status: 'PENDING';
  version: 1;
  resolution: null;
  allowedActions: HumanDecisionReviewPendingActions;
}

/** RESOLVED decision: typed resolution, version 2, no further actions. */
export interface HumanDecisionReviewResolvedResponse extends HumanDecisionReviewBaseResponse {
  status: 'RESOLVED';
  version: 2;
  resolution: HumanDecisionReviewResolutionResponse;
  allowedActions: [];
}

export type HumanDecisionReviewResponse =
  | HumanDecisionReviewPendingResponse
  | HumanDecisionReviewResolvedResponse;

const RESTOCK_TITLE = 'Solicitud de reposición de stock';
const RESTOCK_SANITIZED_SUMMARY =
  'El chatbot solicitó una estimación de reposición de stock para un producto.';

const POSITIVE_ACTION = PENDING_ALLOWED_ACTIONS[0];
const NEGATIVE_ACTION = PENDING_ALLOWED_ACTIONS[1];
const MIN_RESTOCK_DAYS = 1;
const MAX_RESTOCK_DAYS = 365;

/** Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Runs of Unicode whitespace, mirroring the HD-02a canonicalizer policy. */
const WHITESPACE_RUN = /\s+/gu;

/** Value-free fail-closed guard: never echoes persisted values. */
function failClosed(): never {
  throw new Error('Malformed persisted human decision review state');
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

function assertValidCreatedAt(record: HumanDecisionReviewRecord): void {
  if (
    !(record.createdAt instanceof Date) ||
    Number.isNaN(record.createdAt.getTime())
  ) {
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
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    failClosed();
  }
}

/**
 * Validates the persisted record (type, dates and intake snapshot invariants)
 * BEFORE any projection. A malformed row fails closed.
 */
function assertReviewableRecord(record: HumanDecisionReviewRecord): void {
  if (record.type !== RESTOCK_TYPE) {
    failClosed();
  }
  assertValidCreatedAt(record);
  assertValidProductName(record.productName);
  assertValidOptionalSku(record.sku);
  assertValidUuid(record.productId);
  assertValidOptionalUuid(record.variantId);
  assertPositiveSafeIntegerOrNull(record.requestedQuantity);
  assertNonNegativeSafeIntegerOrNull(record.observedStockAtRequest);
  assertStockObservationPair(
    record.observedStockAtRequest,
    record.stockObservedAt,
  );
}

/** Fresh, exact-typed copy of the fixed pending action tuple. */
function copyPendingActions(): HumanDecisionReviewPendingActions {
  return [PENDING_ALLOWED_ACTIONS[0], PENDING_ALLOWED_ACTIONS[1]];
}

function toSnapshot(
  record: HumanDecisionReviewRecord,
): HumanDecisionReviewSnapshotResponse {
  return {
    branchId: record.branchId,
    branchName: record.branchName,
    productId: record.productId,
    productName: record.productName,
    variantId: record.variantId,
    sku: record.sku,
    requestedQuantity: record.requestedQuantity,
    observedStockAtRequest: record.observedStockAtRequest,
    stockObservedAt: record.stockObservedAt
      ? record.stockObservedAt.toISOString()
      : null,
  };
}

/**
 * Validates the persisted resolution state and returns the typed resolution, or
 * `null` for a well-formed PENDING row. Any malformed state fails closed.
 */
function toResolution(
  record: HumanDecisionReviewRecord,
): HumanDecisionReviewResolutionResponse | null {
  if (record.status === 'PENDING') {
    if (
      record.version !== 1 ||
      record.resolutionAction !== null ||
      record.restockDays !== null ||
      record.resolvedAt !== null ||
      record.resolvedByActorId !== null ||
      record.resolvedByDisplayName !== null
    ) {
      failClosed();
    }
    return null;
  }

  if (record.status !== 'RESOLVED') {
    failClosed();
  }

  if (
    record.version !== 2 ||
    record.resolvedAt === null ||
    record.resolvedByActorId === null ||
    record.resolvedByDisplayName === null
  ) {
    failClosed();
  }
  if (
    !(record.resolvedAt instanceof Date) ||
    Number.isNaN(record.resolvedAt.getTime())
  ) {
    failClosed();
  }
  if (
    typeof record.resolvedByActorId !== 'string' ||
    record.resolvedByActorId.trim().length === 0 ||
    typeof record.resolvedByDisplayName !== 'string' ||
    record.resolvedByDisplayName.trim().length === 0
  ) {
    failClosed();
  }

  const resolvedAt = record.resolvedAt.toISOString();
  const resolvedBy: HumanDecisionReviewResolvedByResponse = {
    id: record.resolvedByActorId,
    displayName: record.resolvedByDisplayName,
  };

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
      action: POSITIVE_ACTION,
      restockDays: record.restockDays,
      resolvedAt,
      resolvedBy,
    };
  }

  if (record.resolutionAction === NEGATIVE_ACTION) {
    if (record.restockDays !== null) {
      failClosed();
    }
    return { action: NEGATIVE_ACTION, resolvedAt, resolvedBy };
  }

  failClosed();
}

/**
 * Pure projection from a persisted decision to the human reviewer DTO.
 * Validates the persisted record first, converts every `Date` to a canonical UTC
 * ISO string without mutating the input, and derives `allowedActions` solely
 * from the caller's resolve capability. Throws a value-free `Error` on a
 * malformed persisted state.
 */
export function toHumanDecisionReviewResponse(
  decision: HumanDecisionReviewRecord,
  canResolve: boolean,
): HumanDecisionReviewResponse {
  assertReviewableRecord(decision);
  const resolution = toResolution(decision);
  const base: HumanDecisionReviewBaseResponse = {
    id: decision.id,
    type: RESTOCK_TYPE,
    title: RESTOCK_TITLE,
    sanitizedSummary: RESTOCK_SANITIZED_SUMMARY,
    createdAt: decision.createdAt.toISOString(),
    snapshot: toSnapshot(decision),
  };

  if (resolution === null) {
    return {
      ...base,
      status: 'PENDING',
      version: 1,
      resolution: null,
      allowedActions: canResolve ? copyPendingActions() : [],
    };
  }

  return {
    ...base,
    status: 'RESOLVED',
    version: 2,
    resolution,
    allowedActions: [],
  };
}
