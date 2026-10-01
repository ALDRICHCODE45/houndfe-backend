/**
 * HD-04b3 — PORT: IHumanDecisionReviewReadRepository (driven read port).
 *
 * Tenant-scoped READ contract for the human reviewer inbox:
 *   * `listPending` — the `PENDING` review queue, oldest-first.
 *   * `findById` — one decision by id, `PENDING` or `RESOLVED`.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * TRUST BOUNDARY: the caller supplies only pagination and an optional search
 * term. `tenantId`, `source` and `type` are NEVER taken from the caller. The
 * adapter resolves `tenantId` from `TenantPrismaService.getTenantId()`, which
 * throws when no tenant context exists — INCLUDING for a superadmin session —
 * and pins `source`/`type` to the RESTOCK server constants in every WHERE
 * clause. `listPending` hardcodes `status: 'PENDING'`; a runtime `status` key
 * on the query object is ignored, so a caller can never widen the queue.
 *
 * SELECT SAFETY: the adapter selects ONLY the `HumanDecisionReviewRecord`
 * fields the reviewer projection needs. Authority/server-only columns
 * (`sourceRequestId`, `source`, `tenantId`, `canonicalRequestHash`,
 * `submittedCredentialId`, `resolutionRequestId`, the `resolvedById` FK,
 * `supersedesDecisionId`, application/provider/outcome evidence, customer PII
 * and bot audit) are never read into the read model.
 *
 * NO PRESENTATION COUPLING: this port deliberately does NOT reference the
 * presentation DTO. The record shape lives here so the pure mapper
 * (`toHumanDecisionReviewResponse`) and the Prisma adapter share ONE type and
 * cannot drift. Transport validation stays in `ListHumanDecisionsQueryDto` and
 * the HD-04d controller; the adapter re-checks only the arguments it must hand
 * to Prisma (page/limit/skip/search shape) as VALUE-FREE defense-in-depth for
 * a caller that bypasses the DTO.
 *
 * DB-FREE PROOF ONLY: the HD-04b3 adapter specs mock `TenantPrismaService`, so
 * they prove the adapter seams but NOT real PostgreSQL `ILIKE` wildcard
 * behavior, CLS ALS or the tenant-scoping extension. HD-04b3b owns the
 * dedicated local PostgreSQL integration proof.
 */
import { DomainError } from '../../shared/domain/domain-error';

/**
 * Persisted row shape consumed by the reviewer mapper. Structurally compatible
 * with a selected Prisma `HumanDecision` row (the wider `string`/`string|null`
 * enums accept the generated enum values); the mapper re-validates at runtime
 * because a persisted row must never be trusted blindly.
 *
 * This is the exact SELECT allowlist of the HD-04b3 read adapter. Adding a
 * field here is a deliberate widening of what a reviewer may read, so it must
 * never include authority, credential, provider/outcome or customer fields.
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
  /**
   * EXPIRATION-only snapshot columns (absent/`null` for RESTOCK). OPTIONAL so
   * the RESTOCK-only adapter SELECT stays assignable; the pure reviewer mapper
   * fails closed when an EXPIRATION row omits or contradicts one. The wire
   * `unit` renders from `productUnit`; there is no SKU on an EXPIRATION
   * decision, and `variantName` is required whenever `variantId` is set.
   */
  productUnit?: string | null;
  variantName?: string | null;
  variantOption?: string | null;
  variantValue?: string | null;
  /** EXPIRATION-only operator text; absent/`null` for RESTOCK and unavailable. */
  expirationText?: string | null;
}

/**
 * Value-free read failure. Raised only for a programmer/transport-bypass
 * argument (non-integer page, non-whitelisted limit, an offset that would
 * overflow Prisma's INT32 `skip`, or a non-string/blank search or id). The
 * message NEVER echoes the rejected value, so it is safe to surface as a
 * generic 5xx by the scoped error filter.
 */
export class HumanDecisionReviewReadError extends DomainError {
  constructor() {
    super(
      'Invalid human decision review read argument',
      'INVALID_READ_ARGUMENT',
    );
  }
}

/** Hardcoded list status: the human reviewer only ever sees the PENDING queue. */
export const HUMAN_DECISION_REVIEW_PENDING_STATUS = 'PENDING';

/**
 * Whitelisted page sizes. Mirrors the HD-04b2 transport DTO (the transport
 * remains the client-facing source of truth); repeated here so a caller that
 * bypasses the DTO still cannot request an unbounded page.
 */
export const HUMAN_DECISION_REVIEW_LIMIT_VALUES = [20, 50] as const;

/** Largest whitelisted page size. */
export type HumanDecisionReviewLimit =
  (typeof HUMAN_DECISION_REVIEW_LIMIT_VALUES)[number];

/**
 * Prisma/PostgreSQL accepts the `skip` pagination argument as a signed 32-bit
 * integer, so any computed offset must stay within `2^31 - 1`.
 */
export const HUMAN_DECISION_REVIEW_PRISMA_MAX_SKIP = 2_147_483_647;

/** Maximum `search` length in UTF-16 code units (mirrors the HD-04b2 DTO). */
export const HUMAN_DECISION_REVIEW_SEARCH_MAX_LENGTH = 100;

/**
 * Adapter input: 1-based `page`, whitelisted `limit` and an optional search
 * term. `status`, `sortBy` and `sortOrder` intentionally do NOT exist: the
 * adapter hardcodes `PENDING` and the stable `createdAt,id` ascending order.
 */
export interface HumanDecisionReviewListQuery {
  page: number;
  limit: number;
  search?: string;
}

/**
 * One page of the PENDING queue in the FE pagination shape. `pageIndex0` is
 * 0-based; `pageCount` is `ceil(totalCount / pageSize)` and is `0` for an
 * empty result, so an empty queue always serializes as
 * `{ items: [], totalCount: 0, pageCount: 0 }` and never `NaN`/negative.
 */
export interface HumanDecisionReviewPage {
  items: HumanDecisionReviewRecord[];
  pageIndex0: number;
  pageSize: number;
  totalCount: number;
  pageCount: number;
}

export interface IHumanDecisionReviewReadRepository {
  /**
   * One tenant-scoped page of the `PENDING` RESTOCK queue, ordered by
   * `createdAt` ascending with an `id` ascending tiebreak. When `search` is
   * present it matches the persisted `productName` as a LITERAL substring
   * (case-insensitive); the adapter escapes the LIKE wildcards `%`, `_` and
   * `\` so the term is never interpreted as a pattern.
   */
  listPending(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage>;

  /**
   * Recent RESOLVED RESTOCK responses within the inclusive server-owned
   * [now - 7 days, now] window, ordered resolvedAt DESC, id ASC.
   * This listing window does not restrict detail access or delete history.
   */
  listResolved(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage>;

  /**
   * Globally paginated snapshot: PENDING oldest-first, then recent RESOLVED
   * newest-first, each with id ASC tiebreak. Counts and rows share Repeatable
   * Read isolation; ambient transactions are unsupported.
   */
  listAll(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage>;

  /**
   * One tenant-scoped decision by id, `PENDING` or `RESOLVED`. Returns `null`
   * for a missing OR cross-tenant id (the two are indistinguishable to the
   * caller). Never uses `findUnique` by id alone.
   */
  findById(id: string): Promise<HumanDecisionReviewRecord | null>;
}

/** Injection token used by NestJS DI to resolve the interface (HD-04d wires it). */
export const HUMAN_DECISION_REVIEW_READ_REPOSITORY = Symbol(
  'HUMAN_DECISION_REVIEW_READ_REPOSITORY',
);
