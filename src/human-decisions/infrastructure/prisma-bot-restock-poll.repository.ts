/**
 * HD-05b — ADAPTER: PrismaBotRestockPollRepository.
 *
 * Concrete `IBotRestockPollRepository` (HD-05a1) over Prisma. It depends ONLY
 * on `TenantPrismaService` (never the root `PrismaService`), so every query
 * flows through the CLS-driven tenant-scoping extension. `getTenantId()` is
 * called UNCONDITIONALLY before any query, so a superadmin session without a
 * selected tenant fails closed instead of polling across tenants: the explicit
 * `tenantId` predicate is what defeats the factory's
 * `isSuperAdmin && tenantId === null` bypass.
 *
 * PINNED PREDICATE: `findFirst` (never `findUnique` by id alone) with
 * `{ id, tenantId, source: RESTOCK_SOURCE, type: RESTOCK_TYPE }` and NO
 * `status` filter. A missing, cross-tenant or foreign-source id is
 * indistinguishable and returns `null`; both `PENDING` and `RESOLVED` rows
 * resolve, which is the whole point of the bot's CURRENT-state poll.
 *
 * SELECT SAFETY: `BOT_POLL_RECORD_SELECT` is the exact type-safe Prisma SELECT
 * allowlist for the poll mapper record: the immutable intake snapshot plus the
 * mutable resolution columns. Reviewer identity (`resolvedById`, its snapshot
 * columns or a `User` relation), authority/server-only columns (`source`,
 * `tenantId`, `canonicalRequestHash`, `submittedCredentialId`,
 * `resolutionRequestId`), provider/ACK/outcome evidence, bot audit and
 * customer PII are NEVER read. The persisted flat row is converted EXPLICITLY
 * into the nested `BotRestockPollRecord` (9-key snapshot); there is deliberately
 * no spread and no full-row passthrough, so a widened Prisma row could never
 * leak a forbidden field into the poll model.
 *
 * ARGUMENT SAFETY: the transport route (HD-05c) owns the client-facing
 * validation, but a caller that bypasses it must not reach Prisma with an
 * unvalidated id. The adapter therefore rejects a missing, non-string,
 * blank-canonicalized or non-canonical (non RFC 4122 v1-v8) id with the
 * VALUE-FREE `BotRestockPollReadError` BEFORE any query; the rejected value is
 * never echoed.
 *
 * SCOPE: this slice adds ONLY the committed read adapter and its DB-free unit
 * spec. It adds NO HTTP controller, module binding, application-outcome ACK,
 * schema or credential change.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  BotRestockPollReadError,
  type BotRestockPollRecord,
  type IBotRestockPollRepository,
} from '../domain/bot-restock-poll.repository';

/**
 * Exact SELECT allowlist of the bot poll read model. Flat, type-safe and
 * exhaustive for the nested poll record; every authority, credential,
 * provider/outcome, reviewer and customer column is excluded by construction.
 */
export const BOT_POLL_RECORD_SELECT = {
  id: true,
  sourceRequestId: true,
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
  supersedesDecisionId: true,
  resolutionAction: true,
  restockDays: true,
  resolvedAt: true,
} satisfies Prisma.HumanDecisionSelect;

/** Prisma row shape produced by `BOT_POLL_RECORD_SELECT`. */
type BotPollRecordRow = Prisma.HumanDecisionGetPayload<{
  select: typeof BOT_POLL_RECORD_SELECT;
}>;

/**
 * Canonical RFC 4122 UUID (v1-v8, variant 8/9/a/b); the nil UUID is rejected.
 * Mirrors the HD-02a policy the mapper applies to the persisted `id`, so a
 * bypassed value that could never match a persisted row is rejected early.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when `id` is the canonical decision-id shape the mapper accepts. */
function isCanonicalDecisionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_PATTERN.test(id);
}

/**
 * Explicit flat-row -> nested-record conversion. Every field is copied by
 * name; there is deliberately NO spread and no full-row passthrough, so a
 * forbidden column can never survive the projection even if the SELECT or an
 * over-eager mock row carries one.
 */
function toPollRecord(row: BotPollRecordRow): BotRestockPollRecord {
  return {
    id: row.id,
    sourceRequestId: row.sourceRequestId,
    type: row.type,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    snapshot: {
      branchId: row.branchId,
      branchName: row.branchName,
      productId: row.productId,
      productName: row.productName,
      variantId: row.variantId,
      sku: row.sku,
      requestedQuantity: row.requestedQuantity,
      observedStockAtRequest: row.observedStockAtRequest,
      stockObservedAt: row.stockObservedAt,
    },
    supersedesDecisionId: row.supersedesDecisionId,
    resolutionAction: row.resolutionAction,
    restockDays: row.restockDays,
    resolvedAt: row.resolvedAt,
  };
}

@Injectable()
export class PrismaBotRestockPollRepository implements IBotRestockPollRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findById(id: string): Promise<BotRestockPollRecord | null> {
    // Fail closed BEFORE any tenant/query work for a bypassed argument; the
    // error message never echoes the rejected value.
    if (!isCanonicalDecisionId(id)) {
      throw new BotRestockPollReadError();
    }

    // Tenant is resolved FIRST and unconditionally, so a superadmin session
    // without a tenant fails closed instead of reading across tenants.
    const tenantId = this.tenantPrisma.getTenantId();
    const db = this.tenantPrisma.getClient();

    // `findFirst` + explicit tenant/source/type: never `findUnique` by id
    // alone, and no status filter so both PENDING and RESOLVED resolve.
    const row: BotPollRecordRow | null = await db.humanDecision.findFirst({
      where: {
        id,
        tenantId,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      },
      select: BOT_POLL_RECORD_SELECT,
    });

    return row === null ? null : toPollRecord(row);
  }
}
