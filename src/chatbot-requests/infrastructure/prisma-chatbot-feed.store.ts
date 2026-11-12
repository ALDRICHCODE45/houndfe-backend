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
import { emitRealtimeEvents } from '../../shared/realtime/realtime-event-writes';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import { messageStatusForOutcome } from '../domain/live-session';
import { applyStaffMessageOutcome } from './live-session-writes';
import {
  classifyOutcome,
  DEFERRED_OUTCOMES,
  FEED_LIMITS,
  FEED_TYPE,
  type FeedOutcome,
  type FeedOutcomeInput,
  isDeferredOutcome,
} from '../domain/chatbot-feed';

const ITEM_SELECT = {
  cursor: true,
  deliveryId: true,
  type: true,
  requestId: true,
  conversationRef: true,
  payload: true,
} as const;

/** The pending list also needs the outcome: it names the deferral. */
const PENDING_SELECT = { ...ITEM_SELECT, outcome: true } as const;

interface LockedDelivery {
  cursor: bigint;
  requestId: string;
  type: string;
  attemptId: string | null;
  evidenceHash: string | null;
  outcome: FeedOutcome | null;
  ackedAt: Date | null;
  messageId: string | null;
}

const DAY_MS = 86_400_000;

/** Largest `bigint` (the cursor column's type): the upper end of a tenant's range. */
const MAX_CURSOR = 9223372036854775807n;

/**
 * A tenant's highest feed cursor (NULL for a tenant with no items), always
 * through `(tenantId, cursor)`. `max("cursor") WHERE "tenantId" = $1` would let
 * the planner walk the primary key backwards from the end of the table
 * filtering by tenant, which reads every newer row of every other tenant. With
 * the equality written as a closed range the tenant column is no longer
 * constant, so `ORDER BY "tenantId" DESC, "cursor" DESC` can only be answered
 * by `(tenantId, cursor)`: one index probe.
 */
export const tenantHeadCursor = (tenantId: string) => Prisma.sql`(
  SELECT "cursor" FROM "chatbot_feed_items"
  WHERE "tenantId" >= ${tenantId} AND "tenantId" <= ${tenantId}
  ORDER BY "tenantId" DESC, "cursor" DESC LIMIT 1)`;

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

  /**
   * `(tenantId, cursor)` must answer this read, never the primary key.
   * `cursor` is a global sequence, so the primary key is also an ordered path
   * to "cursor > after" filtered by tenant, and a planner that takes it walks
   * every other tenant's rows between `after` and this tenant's next item
   * (measured: 78 ms and 21 852 buffers for a tenant idle behind 270 000
   * foreign rows; a head-cursor bound only fixed the caught-up case, not a
   * mid-share tenant after a gap). So the statement gives it no such path: the
   * tenant is not compared with `=` (a constant would drop it from the
   * ordering) and the range is a pair of row comparisons, ordered by
   * `("tenantId", "cursor")`. Only the composite index can serve that without
   * sorting the table, and `(t, c) > (t, after) AND (t, c) <= (t, MAX)` is
   * exactly `tenantId = t AND cursor > after`.
   */
  readAfter(after: bigint, limit: number): Promise<FeedItemRow[]> {
    const tenantId = this.tenantId;
    return this.db.$queryRaw<FeedItemRow[]>(Prisma.sql`
      SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId",
             "conversationRef", "payload"
      FROM "chatbot_feed_items"
      WHERE ("tenantId", "cursor") > (${tenantId}, ${after})
        AND ("tenantId", "cursor") <= (${tenantId}, ${MAX_CURSOR})
      ORDER BY "tenantId", "cursor" LIMIT ${limit}`);
  }

  pendingDeferred(
    filter: { conversationRef: string } | { requestId: string },
    limit: number,
  ): Promise<FeedItemRow[]> {
    return this.db.chatbotFeedItem.findMany({
      where: {
        tenantId: this.tenantId,
        ...filter,
        outcome: { in: [...DEFERRED_OUTCOMES] },
        ackedAt: null,
      },
      orderBy: { cursor: 'asc' },
      take: limit,
      select: PENDING_SELECT,
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
               "outcome", "ackedAt", "payload"->>'messageId' AS "messageId"
        FROM "chatbot_feed_items"
        WHERE "tenantId" = ${tenantId} AND "deliveryId" = ${deliveryId}::uuid
        FOR UPDATE`);
      if (!row) {
        // The filter merges `extra` over the generic message of the code.
        throw new ChatbotRequestCommandError('NOT_FOUND', 404, undefined, {
          message: 'Delivery not found',
        });
      }

      // L4: an attempt this delivery already applied (an older deferral, after
      // a later attempt) is a replay, answered from its audit event with the
      // state it had; it never overwrites the current state.
      if (row.attemptId !== null && row.attemptId !== input.attemptId) {
        const prior = await this.findAppliedAttempt(
          row.requestId,
          deliveryId,
          input.attemptId,
        );
        if (prior) {
          if (prior.evidenceHash !== hash) {
            throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
          }
          return this.toAck(
            deliveryId,
            prior.outcome,
            input.attemptId,
            prior.ackReceivedAt ? new Date(prior.ackReceivedAt) : null,
          );
        }
      }

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

      const ackedAt = isDeferredOutcome(input.outcome) ? null : new Date();
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
            // Enough to replay this attempt later (L4).
            evidenceHash: hash,
            ackReceivedAt: ackedAt ? ackedAt.toISOString() : null,
            // DELIVERY_UNKNOWN: the bot does not retry; staff reconcile (§3.3).
            needsReconciliation: input.outcome === 'DELIVERY_UNKNOWN',
          },
        },
      });
      // Unit 11: the outcome of a staff message or template moves the
      // message's status, stores its wamid and tells the attendee (the realtime
      // lock is the last lock of the transaction).
      if (
        row.messageId &&
        (row.type === FEED_TYPE.staffMessage ||
          row.type === FEED_TYPE.templateRequested) &&
        input.outcome !== 'DEFERRED_HUMAN_SESSION'
      ) {
        const applied = await applyStaffMessageOutcome(db, tenantId, {
          messageId: row.messageId,
          status: messageStatusForOutcome(input.outcome),
          providerMessageId: input.providerMessageId ?? null,
          attemptedAt: input.attemptedAt ? new Date(input.attemptedAt) : null,
        });
        if (applied) {
          await emitRealtimeEvents(db, [
            {
              tenantId,
              userId: null,
              type: 'message.status',
              requestId: row.requestId,
              payload: {
                messageId: row.messageId,
                seq: applied.seq,
                deliveryStatus: applied.deliveryStatus,
              },
            },
          ]);
        }
      }
      return this.toAck(deliveryId, input.outcome, input.attemptId, ackedAt);
    });
  }

  /** The audit event of an applied attempt of this delivery, if any. */
  private async findAppliedAttempt(
    requestId: string,
    deliveryId: string,
    attemptId: string,
  ): Promise<{
    outcome: FeedOutcome;
    evidenceHash: string;
    ackReceivedAt: string | null;
  } | null> {
    const event = await this.db.chatbotRequestEvent.findFirst({
      where: {
        tenantId: this.tenantId,
        requestId,
        type: 'DELIVERY_OUTCOME',
        AND: [
          { data: { path: ['deliveryId'], equals: deliveryId } },
          { data: { path: ['attemptId'], equals: attemptId } },
        ],
      },
      select: { data: true },
    });
    const data = event?.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data.evidenceHash !== 'string') return null;
    return {
      outcome: data.outcome as FeedOutcome,
      evidenceHash: data.evidenceHash,
      ackReceivedAt:
        typeof data.ackReceivedAt === 'string' ? data.ackReceivedAt : null,
    };
  }

  /**
   * Retention (§3.3: 30 days). Deletes one batch and raises the tenant's
   * watermark in the same statement, so a cursor older than what was removed
   * answers 410. `SKIP LOCKED` keeps two replicas from fighting over rows. A
   * system operation across tenants, hence the root client; a scheduler calls
   * it (unit 7's sweep). The watermark rows are upserted in `tenantId` order:
   * two replicas delete different rows of the same tenants, and marks locked
   * in different orders would deadlock (40P01). Returns the number of items
   * removed.
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
        ORDER BY "tenantId"
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
