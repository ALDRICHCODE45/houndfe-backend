/**
 * APPLICATION: the 12-month purge of the conversation mirror (human-
 * intervention unit 9; contract §3.6, §6.2, §10.1 "Purga de 12 meses").
 *
 * What goes, and what never does: messages, their files (the Spaces objects and
 * then the media rows) and emptied chats. Requests, their `resolution` and
 * their audit are kept forever (§6.2) and are never touched here.
 *
 * Runs outside any request, so it uses the GLOBAL `PrismaService` across
 * tenants. Tenant safety comes from the key layout: an object is deleted only
 * when its key lives under `conversation-media/<row tenant>/`.
 *
 * One call (`purgeBatch`) does, in order, at most one bounded batch of each:
 *   1. FILES. Due, not yet purged rows are CLAIMED with `FOR UPDATE SKIP LOCKED`
 *      stamping a lease (`purgeLeaseUntil`), so replicas take disjoint rows and
 *      no database transaction stays open during the network deletes. The
 *      object is deleted FIRST; only then is the row marked purged (`purgedAt`
 *      set, `storageKey` cleared) and, when no message points at it any more,
 *      removed. A failed delete keeps the key, bumps `purgeAttempts`, stamps
 *      `lastPurgeErrorAt` and releases the lease; the rows of the same run skip
 *      it (stamp = run start) and later runs retry it AFTER the rows never
 *      tried, so a row that keeps failing cannot starve newer ones (the same
 *      rule as receipts retention). Deleting a missing object succeeds, so a
 *      crash between delete and mark is retried safely. A crashed replica's
 *      lease expires on its own.
 *   2. MESSAGES. `purgeAfter < now()` rows, oldest first, in one `DELETE` bounded
 *      by a `LIMIT … FOR UPDATE SKIP LOCKED` CTE, inside a transaction that sets
 *      `houndfe.conversation_retention = 'on'`: the immutability trigger lets a
 *      due row go only for this marker.
 *   3. FILE ROWS of the messages just deleted whose file was already purged.
 *   4. CHATS of the messages just deleted that are now empty, idle for a day and
 *      in bot mode (a live session is never deleted from under unit 11).
 *
 * The database clock is the only clock: the trigger enforces `purgeAfter <
 * now()` itself, so an application clock that ran ahead could not make a batch
 * fail. A message and its file are due about the same time (the file was
 * uploaded just before the message), the file first.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReceiptStoragePort } from '../../receipts/domain/receipt-storage.port';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CONVERSATION_MEDIA_STORAGE } from './conversation-media.service';

export const CONVERSATION_RETENTION_LIMITS = {
  /** Messages per batch (§10.1: batches of 1 000). */
  messageBatch: 1000,
  /** Files per batch: each costs a network delete. */
  mediaBatch: 100,
  /** A claimed row is retried by another replica after this long. */
  leaseMinutes: 5,
  /** An emptied chat must be idle this long before it is deleted. */
  chatIdleDays: 1,
} as const;

export interface ConversationRetentionResult {
  mediaClaimed: number;
  mediaPurged: number;
  mediaFailed: number;
  messagesDeleted: number;
  conversationsDeleted: number;
  /** A batch came back full: more may be due. */
  hasMore: boolean;
}

type Db = Pick<PrismaService, '$queryRaw' | '$executeRaw' | '$transaction'>;

interface Claimed {
  id: string;
  tenantId: string;
  storageKey: string | null;
}

@Injectable()
export class ConversationRetentionService {
  private readonly logger = new Logger(ConversationRetentionService.name);

  constructor(
    // The global client: the purge crosses tenants on purpose (a system flow).
    @Inject(PrismaService) private readonly prisma: Db,
    @Inject(CONVERSATION_MEDIA_STORAGE)
    private readonly storage: ReceiptStoragePort,
  ) {}

  async purgeBatch(
    input: {
      batchSize?: number;
      mediaBatchSize?: number;
      /** Stamp of this run; the rows that failed in it wait for the next. */
      runStartedAt?: Date;
    } = {},
  ): Promise<ConversationRetentionResult> {
    const batchSize =
      input.batchSize ?? CONVERSATION_RETENTION_LIMITS.messageBatch;
    const mediaBatch =
      input.mediaBatchSize ?? CONVERSATION_RETENTION_LIMITS.mediaBatch;
    const runStartedAt = input.runStartedAt ?? new Date();

    const media = await this.purgeMedia(mediaBatch, runStartedAt);
    const messages = await this.deleteMessages(batchSize);

    return {
      mediaClaimed: media.claimed,
      mediaPurged: media.purged,
      mediaFailed: media.failed,
      messagesDeleted: messages.deleted,
      conversationsDeleted: messages.conversationsDeleted,
      // A full batch of files that ALL failed is not progress: counting it would
      // make the scheduler retry the same broken rows on every tick.
      hasMore:
        (media.claimed >= mediaBatch && media.purged > 0) ||
        messages.deleted >= batchSize,
    };
  }

  // ------------------------------------------------------------- files

  private async purgeMedia(batch: number, runStartedAt: Date) {
    const claimed = await this.prisma.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE "conversation_media" m
      SET "purgeLeaseUntil" = now() + (${CONVERSATION_RETENTION_LIMITS.leaseMinutes} * interval '1 minute')
      WHERE m."id" IN (
        SELECT "id" FROM "conversation_media"
        WHERE "purgedAt" IS NULL AND "purgeAfter" < now()
          AND ("purgeLeaseUntil" IS NULL OR "purgeLeaseUntil" < now())
          AND ("lastPurgeErrorAt" IS NULL OR "lastPurgeErrorAt" < ${runStartedAt})
        ORDER BY "purgeAttempts", "purgeAfter", "id"
        LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      RETURNING m."id", m."tenantId", m."storageKey"`);

    let purged = 0;
    let failed = 0;
    for (const row of claimed) {
      const prefix = `conversation-media/${row.tenantId}/`;
      if (!row.storageKey || !row.storageKey.startsWith(prefix)) {
        // Never delete an object this row does not own.
        this.logger.error(
          `Conversation media ${row.id} has no key inside its tenant prefix; not purged`,
        );
        await this.recordFailure(row.id, runStartedAt);
        failed += 1;
        continue;
      }
      try {
        await this.storage.remove(row.storageKey);
      } catch (error) {
        this.logger.warn(
          `Conversation media ${row.id} purge failed, will retry (${error instanceof Error ? error.name : 'error'})`,
        );
        await this.recordFailure(row.id, runStartedAt);
        failed += 1;
        continue;
      }
      await this.markPurged(row.id);
      purged += 1;
    }
    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Conversation media retention: claimed=${claimed.length} purged=${purged} failed=${failed}`,
      );
    }
    return { claimed: claimed.length, purged, failed };
  }

  private async markPurged(id: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "conversation_media"
      SET "purgedAt" = now(), "storageKey" = NULL, "purgeLeaseUntil" = NULL
      WHERE "id" = ${id} AND "purgedAt" IS NULL`);
    await this.deleteUnreferencedMedia([id]);
  }

  private async recordFailure(id: string, runStartedAt: Date): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "conversation_media"
      SET "purgeAttempts" = "purgeAttempts" + 1, "lastPurgeErrorAt" = ${runStartedAt},
          "purgeLeaseUntil" = NULL
      WHERE "id" = ${id} AND "purgedAt" IS NULL`);
  }

  /**
   * A purged file row nobody points at is dead weight. While a message still
   * points at it the row stays, so the timeline can say "purged".
   */
  private async deleteUnreferencedMedia(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "conversation_media" m
      WHERE m."id" = ANY(${ids}::text[]) AND m."purgedAt" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "conversation_messages" x
          WHERE x."tenantId" = m."tenantId" AND x."mediaId" = m."id")`);
  }

  // ---------------------------------------------------------- messages

  private async deleteMessages(batch: number) {
    const deleted = await this.prisma.$transaction(async (tx) => {
      // The marker lives and dies with this transaction (`is_local`).
      await tx.$queryRaw(
        Prisma.sql`SELECT set_config('houndfe.conversation_retention', 'on', true)`,
      );
      return tx.$queryRaw<
        Array<{ conversationId: string; mediaId: string | null }>
      >(Prisma.sql`
        WITH due AS (
          SELECT "id" FROM "conversation_messages"
          WHERE "purgeAfter" < now()
          ORDER BY "purgeAfter", "id"
          LIMIT ${batch} FOR UPDATE SKIP LOCKED)
        DELETE FROM "conversation_messages" m
        USING due WHERE m."id" = due."id"
        RETURNING m."conversationId", m."mediaId"`);
    });
    if (deleted.length === 0) return { deleted: 0, conversationsDeleted: 0 };

    await this.deleteUnreferencedMedia([
      ...new Set(deleted.flatMap((r) => (r.mediaId ? [r.mediaId] : []))),
    ]);
    const conversationsDeleted = await this.deleteEmptyChats([
      ...new Set(deleted.map((r) => r.conversationId)),
    ]);
    this.logger.log(
      `Conversation retention: messages=${deleted.length} chats=${conversationsDeleted}`,
    );
    return { deleted: deleted.length, conversationsDeleted };
  }

  private async deleteEmptyChats(ids: string[]): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "chatbot_conversations" c
      WHERE c."id" IN (
        SELECT "id" FROM "chatbot_conversations" k
        WHERE k."id" = ANY(${ids}::text[]) AND k."mode" = 'BOT'
          AND k."updatedAt" < now() - (${CONVERSATION_RETENTION_LIMITS.chatIdleDays} * interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM "conversation_messages" m WHERE m."conversationId" = k."id")
        FOR UPDATE SKIP LOCKED)`);
  }
}
