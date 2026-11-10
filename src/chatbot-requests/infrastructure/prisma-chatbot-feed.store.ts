/**
 * Prisma adapter of `ChatbotFeedStore` (unit 5, slice 5b). The tenant always
 * comes from CLS. Reads are single short queries (no connection is held while
 * a long-poll waits). The outcome runs in one transaction: `SELECT … FOR
 * UPDATE` on the delivery, the pure classification, the update and the audit
 * event. The only other lock the ACK touches is the FK share lock on the
 * request row when the event is inserted, and no command waits for a feed item
 * row, so no cycle can include it.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  type ChatbotFeedStore,
  type FeedItemRow,
  type OutcomeAck,
} from '../application/chatbot-feed.service';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import {
  classifyOutcome,
  FEED_LIMITS,
  type FeedOutcome,
  type FeedOutcomeInput,
} from '../domain/chatbot-feed';

const ITEM_SELECT = {
  cursor: true,
  deliveryId: true,
  type: true,
  requestId: true,
  conversationRef: true,
  payload: true,
} as const;

interface LockedDelivery {
  cursor: bigint;
  requestId: string;
  type: string;
  attemptId: string | null;
  evidenceHash: string | null;
  outcome: FeedOutcome | null;
  ackedAt: Date | null;
}

const DAY_MS = 86_400_000;

@Injectable()
export class PrismaChatbotFeedStore implements ChatbotFeedStore {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  /** A cursor below the purge watermark may have skipped items (§3.3). */
  async assertCursorRetained(after: bigint): Promise<void> {
    const retention = await this.db.chatbotFeedRetention.findFirst({
      where: { tenantId: this.tenantId },
      select: { purgedThroughCursor: true },
    });
    if (retention && after < retention.purgedThroughCursor) {
      throw new ChatbotRequestCommandError('CURSOR_EXPIRED', 410);
    }
  }

  readAfter(after: bigint, limit: number): Promise<FeedItemRow[]> {
    return this.db.chatbotFeedItem.findMany({
      where: { tenantId: this.tenantId, cursor: { gt: after } },
      orderBy: { cursor: 'asc' },
      take: limit,
      select: ITEM_SELECT,
    });
  }

  pendingDeferred(
    conversationRef: string,
    limit: number,
  ): Promise<FeedItemRow[]> {
    return this.db.chatbotFeedItem.findMany({
      where: {
        tenantId: this.tenantId,
        conversationRef,
        outcome: 'DEFERRED_WINDOW_CLOSED',
        ackedAt: null,
      },
      orderBy: { cursor: 'asc' },
      take: limit,
      select: ITEM_SELECT,
    });
  }

  recordOutcome(
    deliveryId: string,
    credentialId: string,
    input: FeedOutcomeInput,
    hash: string,
  ): Promise<OutcomeAck> {
    return this.tenantPrisma.runInTransaction(async () => {
      const { db, tenantId } = this;
      const [row] = await db.$queryRaw<LockedDelivery[]>(Prisma.sql`
        SELECT "cursor", "requestId", "type", "attemptId", "evidenceHash",
               "outcome", "ackedAt"
        FROM "chatbot_feed_items"
        WHERE "tenantId" = ${tenantId} AND "deliveryId" = ${deliveryId}::uuid
        FOR UPDATE`);
      if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);

      const decision = classifyOutcome(row, input, hash);
      if (decision === 'REPLAY') {
        return this.toAck(deliveryId, row.outcome, row.attemptId, row.ackedAt);
      }
      if (decision === 'IDEMPOTENCY_CONFLICT') {
        throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
      }
      if (decision === 'OUTCOME_ALREADY_RECORDED') {
        throw new ChatbotRequestCommandError('OUTCOME_ALREADY_RECORDED', 409);
      }
      if (decision === 'OUTCOME_NOT_ALLOWED') {
        throw new ChatbotRequestCommandError('OUTCOME_NOT_ALLOWED', 422);
      }

      const ackedAt =
        input.outcome === 'DEFERRED_WINDOW_CLOSED' ? null : new Date();
      await db.chatbotFeedItem.updateMany({
        where: { tenantId, cursor: row.cursor },
        data: {
          outcome: input.outcome,
          attemptId: input.attemptId,
          evidenceHash: hash,
          attemptedAt: input.attemptedAt ? new Date(input.attemptedAt) : null,
          providerMessageId: input.providerMessageId ?? null,
          ackedAt,
        },
      });
      // The request's own version at ack time; an ACK changes no request state.
      const request = await db.chatbotRequest.findFirst({
        where: { tenantId, id: row.requestId },
        select: { version: true },
      });
      await db.chatbotRequestEvent.create({
        data: {
          tenantId,
          requestId: row.requestId,
          type: 'DELIVERY_OUTCOME',
          actorKind: 'SERVICE',
          actorId: credentialId,
          actorDisplayName: null,
          version: request?.version ?? 1,
          data: {
            deliveryId,
            feedType: row.type,
            outcome: input.outcome,
            attemptId: input.attemptId,
            // DELIVERY_UNKNOWN: the bot does not retry; staff reconcile (§3.3).
            needsReconciliation: input.outcome === 'DELIVERY_UNKNOWN',
          },
        },
      });
      return this.toAck(deliveryId, input.outcome, input.attemptId, ackedAt);
    });
  }

  /**
   * Retention (§3.3: 30 days). Deletes one batch and raises the tenant's
   * watermark in the same statement, so a cursor older than what was removed
   * answers 410. `SKIP LOCKED` keeps two replicas from fighting over rows. A
   * system operation across tenants, hence the root client; a scheduler calls
   * it (unit 7's sweep). Returns the number of items removed.
   */
  async purgeExpired(now: Date, batch = 1000): Promise<number> {
    const cutoff = new Date(now.getTime() - FEED_LIMITS.retentionDays * DAY_MS);
    const [result] = await this.prisma.$queryRaw<{ removed: number }[]>(
      Prisma.sql`
      WITH doomed AS (
        SELECT "cursor" FROM "chatbot_feed_items"
        WHERE "createdAt" < ${cutoff}
        ORDER BY "createdAt" LIMIT ${batch}
        FOR UPDATE SKIP LOCKED),
      gone AS (
        DELETE FROM "chatbot_feed_items" f USING doomed d
        WHERE f."cursor" = d."cursor" RETURNING f."tenantId", f."cursor"),
      marks AS (
        INSERT INTO "chatbot_feed_retention" ("tenantId", "purgedThroughCursor")
        SELECT "tenantId", max("cursor") FROM gone GROUP BY "tenantId"
        ON CONFLICT ("tenantId") DO UPDATE SET "purgedThroughCursor" =
          GREATEST("chatbot_feed_retention"."purgedThroughCursor",
                   EXCLUDED."purgedThroughCursor")
        RETURNING 1)
      SELECT (SELECT count(*) FROM gone)::int AS "removed"`,
    );
    return result.removed;
  }

  private toAck(
    deliveryId: string,
    outcome: FeedOutcome | null,
    attemptId: string | null,
    ackedAt: Date | null,
  ): OutcomeAck {
    if (!outcome || !attemptId) throw new Error('feed outcome is not recorded');
    return {
      deliveryId,
      outcome,
      attemptId,
      ackReceivedAt: ackedAt ? ackedAt.toISOString() : null,
    };
  }
}
