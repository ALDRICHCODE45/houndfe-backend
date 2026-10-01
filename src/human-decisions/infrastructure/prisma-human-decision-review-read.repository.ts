/**
 * HD-04b3 — ADAPTER: PrismaHumanDecisionReviewReadRepository.
 *
 * Tenant-scoped read adapter for the human reviewer inbox. It depends ONLY on
 * `TenantPrismaService` (never the root `PrismaService`), so every query flows
 * through the CLS-driven tenant-scoping extension. As defense-in-depth the
 * adapter ALSO injects `tenantId` explicitly, which is what defeats the
 * factory's superadmin bypass (`isSuperAdmin && tenantId === null`) for this
 * read model: `getTenantId()` is called unconditionally and throws before any
 * query when there is no tenant context — even for a superadmin.
 *
 * Every `findMany` / `count` / `findFirst` carries the full pinned predicate
 * `{ tenantId, source: RESTOCK_SOURCE, type: { in: [RESTOCK_TYPE,
 * EXPIRATION_TYPE] } }`: the CLOSED two-member RESTOCK/EXPIRATION set (both
 * admitted types share one `source`, so `type` is the discriminator). The
 * caller can never widen past that set. `listPending` additionally hardcodes
 * `status: 'PENDING'` and ignores any `status` key on the caller object, so the
 * review queue can never be widened.
 *
 * ORDER + PAGINATION: `createdAt` ascending with an `id` ascending tiebreak,
 * `skip = (page - 1) * limit`, `take = limit` (whitelisted `20 | 50`). Page,
 * limit and the computed skip are re-validated here because a caller may
 * bypass the transport DTO: a non-integer page, a non-whitelisted limit or an
 * offset above Prisma's INT32 `skip` range throws a VALUE-FREE
 * `HumanDecisionReviewReadError` before any query. The transport DTO remains
 * the client-facing validator.
 *
 * SEARCH SAFETY: Prisma `contains` + `mode: 'insensitive'` compiles to
 * `LIKE`/`ILIKE` on PostgreSQL. Parameterization prevents SQL injection, but
 * `%`, `_` and the escape character `\` keep PATTERN meaning. The adapter
 * escapes all three (`term.replace(/[\\%_]/gu, '\\$&')`) so the term is always
 * a LITERAL substring match. Only the persisted `productName` is searched.
 *
 * SELECT SAFETY: the adapter selects the exact `HumanDecisionReviewRecord`
 * allowlist, INCLUDING the five EXPIRATION-only columns (`productUnit`,
 * `variantName`, `variantOption`, `variantValue`, `expirationText`; `null` on a
 * RESTOCK row). It never reads `sourceRequestId`, `source`, `tenantId`,
 * `canonicalRequestHash`, `submittedCredentialId`, `resolutionRequestId`, the
 * `resolvedById` FK, `supersedesDecisionId`, application/provider/outcome
 * evidence, customer PII or bot audit.
 *
 * DETAIL: `findById` uses `findFirst` (never `findUnique` by id alone) with
 * `{ id, tenantId, source, type: <closed RESTOCK/EXPIRATION set> }` and NO
 * status filter, so it resolves both `PENDING` and `RESOLVED` of EITHER admitted
 * type and returns `null` for a missing OR cross-tenant id (the two are
 * indistinguishable). There is no branch-level authorization beyond the tenant
 * scope.
 *
 * DB-FREE PROOF: the companion spec mocks `TenantPrismaService`; it proves the
 * seams above, NOT real PostgreSQL `ILIKE`/CLS/tenant-extension behavior.
 * HD-04b3b owns the dedicated local PostgreSQL integration proof.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import {
  HUMAN_DECISION_REVIEW_LIMIT_VALUES,
  HUMAN_DECISION_REVIEW_PENDING_STATUS,
  HUMAN_DECISION_REVIEW_PRISMA_MAX_SKIP,
  HUMAN_DECISION_REVIEW_SEARCH_MAX_LENGTH,
  HumanDecisionReviewReadError,
  type HumanDecisionReviewListQuery,
  type HumanDecisionReviewPage,
  type HumanDecisionReviewRecord,
  type IHumanDecisionReviewReadRepository,
} from '../domain/human-decision-review-read.repository';

/**
 * Exact SELECT allowlist of the reviewer read model, covering BOTH admitted
 * types: the RESTOCK snapshot/resolution columns plus the five EXPIRATION-only
 * columns (`null` on a RESTOCK row). Excludes every authority, credential,
 * provider/outcome and customer column by construction. Exported so the HD-04c2
 * resolve adapter reuses the SAME projection for its committed read and cannot
 * drift back toward returning a full Prisma row.
 */
export const REVIEW_RECORD_SELECT = {
  id: true,
  type: true,
  status: true,
  version: true,
  createdAt: true,
  branchId: true,
  branchName: true,
  productId: true,
  productName: true,
  variantId: true,
  sku: true,
  requestedQuantity: true,
  observedStockAtRequest: true,
  stockObservedAt: true,
  resolutionAction: true,
  restockDays: true,
  resolvedAt: true,
  resolvedByActorId: true,
  resolvedByDisplayName: true,
  // EXPIRATION-only snapshot/resolution columns (NULL on a RESTOCK row).
  productUnit: true,
  variantName: true,
  variantOption: true,
  variantValue: true,
  expirationText: true,
} satisfies Prisma.HumanDecisionSelect;

/** Prisma row shape produced by `REVIEW_RECORD_SELECT`. */
type ReviewRecordRow = Prisma.HumanDecisionGetPayload<{
  select: typeof REVIEW_RECORD_SELECT;
}>;

/**
 * LIKE/ILIKE metacharacters that keep pattern meaning even when the term is
 * parameterized: the escape character itself plus the two wildcards.
 */
const LIKE_WILDCARD_PATTERN = /[\\%_]/gu;

/**
 * Escape `\`, `%` and `_` so PostgreSQL treats the term as a literal
 * substring. A single pass is required because `$&` inserts the matched
 * character literally, so `\` becomes `\\` and is not re-scanned as an escape.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(LIKE_WILDCARD_PATTERN, '\\$&');
}

/** True when `limit` is one of the whitelisted page sizes. */
function isAllowedLimit(limit: number): boolean {
  return HUMAN_DECISION_REVIEW_LIMIT_VALUES.some(
    (allowed) => allowed === limit,
  );
}

/**
 * Validate the DB pagination arguments and return the offset. Throws a
 * value-free error for a bypassed/unsafe page, a non-whitelisted limit or an
 * offset that would overflow Prisma's signed INT32 `skip`.
 */
function resolveSafeSkip(page: number, limit: number): number {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new HumanDecisionReviewReadError();
  }
  if (!Number.isSafeInteger(limit) || !isAllowedLimit(limit)) {
    throw new HumanDecisionReviewReadError();
  }
  const skip = (page - 1) * limit;
  if (
    !Number.isSafeInteger(skip) ||
    skip > HUMAN_DECISION_REVIEW_PRISMA_MAX_SKIP
  ) {
    throw new HumanDecisionReviewReadError();
  }
  return skip;
}

/**
 * Validate the optional search term without echoing it. The transport DTO owns
 * NFC/whitespace normalization and control rejection; the adapter only rejects
 * a term it cannot safely pass to Prisma.
 */
function assertValidSearch(search: unknown): void {
  if (search === undefined) {
    return;
  }
  if (
    typeof search !== 'string' ||
    search.trim().length === 0 ||
    search.length > HUMAN_DECISION_REVIEW_SEARCH_MAX_LENGTH
  ) {
    throw new HumanDecisionReviewReadError();
  }
}

/** Optional read clock; separate from the resolution-write clock. */
export type HumanDecisionReviewReadClock = () => Date;
export const HUMAN_DECISION_REVIEW_READ_CLOCK = Symbol(
  'HUMAN_DECISION_REVIEW_READ_CLOCK',
);
const RECENT_RESOLVED_WINDOW_MS = 604_800_000;

@Injectable()
export class PrismaHumanDecisionReviewReadRepository implements IHumanDecisionReviewReadRepository {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Optional()
    @Inject(HUMAN_DECISION_REVIEW_READ_CLOCK)
    private readonly clock?: HumanDecisionReviewReadClock,
  ) {}

  async listPending(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage> {
    if (query === null || typeof query !== 'object') {
      throw new HumanDecisionReviewReadError();
    }
    const { page, limit, search } = query;
    const skip = resolveSafeSkip(page, limit);
    assertValidSearch(search);

    // Tenant is resolved FIRST and unconditionally, so a superadmin session
    // without a tenant fails closed instead of reading across tenants.
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();

    const where: Prisma.HumanDecisionWhereInput = {
      tenantId,
      source: RESTOCK_SOURCE,
      type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
      // Hardcoded: a caller-supplied `status` is ignored by construction.
      status: HUMAN_DECISION_REVIEW_PENDING_STATUS,
    };
    if (search !== undefined) {
      where.productName = {
        contains: escapeLikeTerm(search),
        mode: 'insensitive',
      };
    }

    const [items, totalCount]: [HumanDecisionReviewRecord[], number] =
      await Promise.all([
        db.humanDecision.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take: limit,
          select: REVIEW_RECORD_SELECT,
        }),
        db.humanDecision.count({ where }),
      ]);

    return {
      items,
      pageIndex0: page - 1,
      pageSize: limit,
      totalCount,
      pageCount: totalCount === 0 ? 0 : Math.ceil(totalCount / limit),
    };
  }

  async listResolved(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage> {
    if (query === null || typeof query !== 'object') {
      throw new HumanDecisionReviewReadError();
    }
    const { page, limit, search } = query;
    const skip = resolveSafeSkip(page, limit);
    assertValidSearch(search);
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    const now = this.clock ? this.clock() : new Date();
    const where: Prisma.HumanDecisionWhereInput = {
      tenantId,
      source: RESTOCK_SOURCE,
      type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
      status: 'RESOLVED',
      resolvedAt: {
        gte: new Date(now.getTime() - RECENT_RESOLVED_WINDOW_MS),
        lte: now,
      },
    };
    if (search !== undefined) {
      where.productName = {
        contains: escapeLikeTerm(search),
        mode: 'insensitive',
      };
    }
    const [items, totalCount]: [HumanDecisionReviewRecord[], number] =
      await Promise.all([
        db.humanDecision.findMany({
          where,
          orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }],
          skip,
          take: limit,
          select: REVIEW_RECORD_SELECT,
        }),
        db.humanDecision.count({ where }),
      ]);
    return {
      items,
      pageIndex0: page - 1,
      pageSize: limit,
      totalCount,
      pageCount: totalCount === 0 ? 0 : Math.ceil(totalCount / limit),
    };
  }

  async listAll(
    query: HumanDecisionReviewListQuery,
  ): Promise<HumanDecisionReviewPage> {
    if (query === null || typeof query !== 'object') {
      throw new HumanDecisionReviewReadError();
    }
    const { page, limit, search } = query;
    const skip = resolveSafeSkip(page, limit);
    assertValidSearch(search);
    // Ambient clients lack $transaction and cannot guarantee this isolation.
    if (this.tenantPrisma.isInTransaction()) {
      throw new HumanDecisionReviewReadError();
    }
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();
    return db.$transaction(
      async (tx) => {
        const now = this.clock ? this.clock() : new Date();
        const scope: Prisma.HumanDecisionWhereInput = {
          tenantId,
          source: RESTOCK_SOURCE,
          type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
          ...(search === undefined
            ? {}
            : {
                productName: {
                  contains: escapeLikeTerm(search),
                  mode: 'insensitive',
                },
              }),
        };
        const pendingWhere: Prisma.HumanDecisionWhereInput = {
          ...scope,
          status: 'PENDING',
        };
        const resolvedWhere: Prisma.HumanDecisionWhereInput = {
          ...scope,
          status: 'RESOLVED',
          resolvedAt: {
            gte: new Date(now.getTime() - RECENT_RESOLVED_WINDOW_MS),
            lte: now,
          },
        };
        const pendingCount = await tx.humanDecision.count({
          where: pendingWhere,
        });
        const resolvedCount = await tx.humanDecision.count({
          where: resolvedWhere,
        });
        const pendingTake = Math.min(limit, Math.max(pendingCount - skip, 0));
        const resolvedSkip = Math.max(skip - pendingCount, 0);
        const resolvedTake = Math.min(
          limit - pendingTake,
          Math.max(resolvedCount - resolvedSkip, 0),
        );
        const pending =
          pendingTake === 0
            ? []
            : await tx.humanDecision.findMany({
                where: pendingWhere,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                skip,
                take: pendingTake,
                select: REVIEW_RECORD_SELECT,
              });
        const resolved =
          resolvedTake === 0
            ? []
            : await tx.humanDecision.findMany({
                where: resolvedWhere,
                orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }],
                skip: resolvedSkip,
                take: resolvedTake,
                select: REVIEW_RECORD_SELECT,
              });
        if (
          pending.some((row) => row.status !== 'PENDING') ||
          resolved.some((row) => row.status !== 'RESOLVED')
        ) {
          throw new HumanDecisionReviewReadError();
        }
        const totalCount = pendingCount + resolvedCount;
        return {
          items: [...pending, ...resolved],
          pageIndex0: page - 1,
          pageSize: limit,
          totalCount,
          pageCount: Math.ceil(totalCount / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findById(id: string): Promise<HumanDecisionReviewRecord | null> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HumanDecisionReviewReadError();
    }

    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();

    // `findFirst` + explicit tenant/source/type: never `findUnique` by id
    // alone, and no status filter so both PENDING and RESOLVED resolve.
    const record: ReviewRecordRow | null = await db.humanDecision.findFirst({
      where: {
        id,
        tenantId,
        source: RESTOCK_SOURCE,
        type: { in: [RESTOCK_TYPE, EXPIRATION_TYPE] },
      },
      select: REVIEW_RECORD_SELECT,
    });

    return record;
  }
}
