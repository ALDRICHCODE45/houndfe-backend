/**
 * Prisma adapter of `ChatbotRecoveryStore` (unit 5, slice 5c). The tenant
 * always comes from CLS. Every statement is a short read that releases its
 * connection; nothing here locks or writes.
 *
 * The page is two index range scans in `(updatedAt, id)` order, merged: the
 * open requests (`chatbot_requests_open_recovery_idx`) and, with `since`, the
 * ones closed at or after it (`chatbot_requests_closed_recovery_idx`; a request
 * closed at or after an instant was last updated at or after it, so the range
 * on `updatedAt` is exact for the index and `closedAt` makes it exact for the
 * rule). Each branch stops after `limit` rows, so a page costs O(limit) however
 * many requests the tenant has closed.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { FeedItemRow } from '../application/chatbot-feed.service';
import { tenantHeadCursor } from './prisma-chatbot-feed.store';
import type {
  ChatbotRecoveryStore,
  RecoveryRequestRow,
  UndeliveredSummary,
} from '../application/chatbot-recovery.service';

const COLUMNS = Prisma.sql`"id", "folio", "kind", "subtype", "status",
  "conversationRef", "humanDecisionId", "deliveryZoneRequestId",
  "receiptEvidenceId", "whatsappWindowClosesAt", "cancelReason", "createdAt",
  "updatedAt", "closedAt"`;

/** `timestamp(3)` columns hold UTC; the ISO string keeps the instant exact. */
const instant = (date: Date) => Prisma.sql`${date.toISOString()}::timestamp(3)`;

/**
 * restock-backorder / T2b: the feed `after` that re-serves the tenant's oldest
 * backorder-level item (`backorder.*`) with no terminal outcome, or no row when
 * there is none. Same shape as `saleResumeAfter`: it never answers below the
 * retention watermark (the purge goes by `createdAt`, so a kept item may sit
 * under it), so that `after` can never answer `410` again. Backorder items are
 * few (a handful per backorder, 30 days of retention) and the partial unique
 * index `chatbot_feed_items_backorder_stage_uq` holds only them, keyed by
 * tenant first.
 */
export const backorderResumeAfterQuery = (tenantId: string) => Prisma.sql`
  SELECT GREATEST(min(f."cursor") - 1,
    COALESCE((SELECT "purgedThroughCursor" FROM "chatbot_feed_retention"
              WHERE "tenantId" = ${tenantId}), 0)) AS "after"
  FROM "chatbot_feed_items" f
  WHERE f."tenantId" = ${tenantId} AND f."backorderId" IS NOT NULL
    AND f."ackedAt" IS NULL
  HAVING count(*) > 0`;

@Injectable()
export class PrismaChatbotRecoveryStore implements ChatbotRecoveryStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  async currentFeedCursor(): Promise<bigint> {
    const tenantId = this.tenantId;
    const [row] = await this.db.$queryRaw<{ cursor: bigint }[]>(Prisma.sql`
      SELECT GREATEST(
        COALESCE(${tenantHeadCursor(tenantId)}, 0),
        COALESCE((SELECT "purgedThroughCursor" FROM "chatbot_feed_retention"
                  WHERE "tenantId" = ${tenantId}), 0)) AS "cursor"`);
    return row.cursor;
  }

  readPage(query: {
    since: Date | null;
    after: { updatedAt: Date; id: string } | null;
    limit: number;
  }): Promise<RecoveryRequestRow[]> {
    const tenantId = this.tenantId;
    const { since, after, limit } = query;
    const keyset = after
      ? Prisma.sql`AND ("updatedAt", "id") > (${instant(after.updatedAt)}, ${after.id})`
      : Prisma.empty;
    const open = Prisma.sql`(
      SELECT ${COLUMNS} FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
        ${keyset}
      ORDER BY "updatedAt", "id" LIMIT ${limit})`;
    const closed = since
      ? Prisma.sql`UNION ALL (
      SELECT ${COLUMNS} FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('RESOLVED', 'CANCELLED')
        AND "updatedAt" >= ${instant(since)} AND "closedAt" >= ${instant(since)}
        ${keyset}
      ORDER BY "updatedAt", "id" LIMIT ${limit})`
      : Prisma.empty;
    return this.db.$queryRaw<RecoveryRequestRow[]>(Prisma.sql`
      SELECT * FROM (${open} ${closed}) AS page
      ORDER BY "updatedAt", "id" LIMIT ${limit}`);
  }

  undelivered(
    requestIds: string[],
    perRequest: number,
  ): Promise<FeedItemRow[]> {
    const tenantId = this.tenantId;
    return this.db.$queryRaw<FeedItemRow[]>(Prisma.sql`
      SELECT d."cursor", d."deliveryId"::text AS "deliveryId", d."type",
             d."requestId", d."conversationRef", d."payload", d."outcome"
      FROM unnest(${requestIds}::text[]) AS r("id")
      CROSS JOIN LATERAL (
        SELECT f."cursor", f."deliveryId", f."type", f."requestId",
               f."conversationRef", f."payload", f."outcome"
        FROM "chatbot_feed_items" f
        WHERE f."tenantId" = ${tenantId} AND f."requestId" = r."id"
          AND f."ackedAt" IS NULL
        ORDER BY f."cursor" DESC LIMIT ${perRequest}) AS d
      ORDER BY d."cursor"`);
  }

  /**
   * pay-in-store-pickup / T3: the oldest sale-level item with no terminal
   * outcome. Sale items are few (at most three per hold version) and the
   * partial unique index `chatbot_feed_items_sale_hold_uq` holds only them,
   * keyed by tenant first. Answers the feed `after` that re-serves it (its
   * cursor minus one), never below the retention watermark (the purge goes
   * by `createdAt`, so a kept item may sit under it): that `after` can never
   * answer `410` again.
   */
  async saleResumeAfter(): Promise<bigint | null> {
    const tenantId = this.tenantId;
    const [row] = await this.db.$queryRaw<{ after: bigint | null }[]>(
      Prisma.sql`
      SELECT GREATEST(min(f."cursor") - 1,
        COALESCE((SELECT "purgedThroughCursor" FROM "chatbot_feed_retention"
                  WHERE "tenantId" = ${tenantId}), 0)) AS "after"
      FROM "chatbot_feed_items" f
      WHERE f."tenantId" = ${tenantId} AND f."saleId" IS NOT NULL
        AND f."ackedAt" IS NULL
      HAVING count(*) > 0`,
    );
    return row?.after ?? null;
  }

  /**
   * restock-backorder / T2b: the oldest backorder-level item with no terminal
   * outcome (see `backorderResumeAfterQuery`). Backorder items belong to no
   * request, so the request walk cannot list them; the bot re-reads them from
   * the feed, and `GET /chatbot-api/backorders?updatedSince=` hands it this
   * position.
   */
  async backorderResumeAfter(): Promise<bigint | null> {
    const [row] = await this.db.$queryRaw<{ after: bigint | null }[]>(
      backorderResumeAfterQuery(this.tenantId),
    );
    return row?.after ?? null;
  }

  undeliveredSummary(requestIds: string[]): Promise<UndeliveredSummary[]> {
    const tenantId = this.tenantId;
    return this.db.$queryRaw<UndeliveredSummary[]>(Prisma.sql`
      SELECT "requestId", count(*)::int AS "count", min("cursor") AS "oldestCursor"
      FROM "chatbot_feed_items"
      WHERE "tenantId" = ${tenantId} AND "requestId" = ANY(${requestIds}::text[])
        AND "ackedAt" IS NULL
      GROUP BY "requestId"`);
  }
}
