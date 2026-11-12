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
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReceiptStoragePort } from '../../receipts/domain/receipt-storage.port';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  CONVERSATION_MEDIA_LISTER,
  type ConversationMediaLister,
} from './conversation-media-lister';
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
  /** Media intents (S2) reconciled per batch: each may cost a network delete. */
  intentBatch: 100,
  /** Orphan sweep (S2): keys read per `ListObjects` page and pages per run. */
  orphanPageSize: 1000,
  orphanPagesPerRun: 5,
  /** An unowned object must be older than this to be swept (uploads in flight). */
  orphanGraceHours: 24,
} as const;

/** `conversation-media/<tenantId>/<mediaId>.<ext>`: the only shape ever written. */
const MEDIA_KEY = /^conversation-media\/([^/]+)\/([0-9a-f-]{36})\.[a-z0-9]+$/;
export const CONVERSATION_MEDIA_PREFIX = 'conversation-media/';

export interface ConversationRetentionResult {
  mediaClaimed: number;
  mediaPurged: number;
  mediaFailed: number;
  messagesDeleted: number;
  conversationsDeleted: number;
  /** S2: media intents settled (object deleted or already owned) and failed. */
  intentsSettled: number;
  intentsFailed: number;
  /** A batch came back full: more may be due. */
  hasMore: boolean;
}

type Db = Pick<PrismaService, '$queryRaw' | '$executeRaw' | '$transaction'>;

interface Claimed {
  id: string;
  tenantId: string;
  storageKey: string | null;
}

interface ClaimedIntent {
  id: string;
  tenantId: string;
  storageKey: string;
  reason: 'UPLOAD' | 'ROW_DELETED';
}

export interface OrphanSweepResult {
  /** Keys looked at (listed pages). */
  scanned: number;
  /** Unowned objects deleted. */
  deleted: number;
  /** Unowned objects whose delete failed (found again on the next pass). */
  failed: number;
  /** Keys that do not have the shape we write: never touched. */
  skipped: number;
  /** The pass reached the end of the prefix; the next run starts over. */
  passCompleted: boolean;
}

@Injectable()
export class ConversationRetentionService {
  private readonly logger = new Logger(ConversationRetentionService.name);

  constructor(
    // The global client: the purge crosses tenants on purpose (a system flow).
    @Inject(PrismaService) private readonly prisma: Db,
    @Inject(CONVERSATION_MEDIA_STORAGE)
    private readonly storage: ReceiptStoragePort,
    @Optional()
    @Inject(CONVERSATION_MEDIA_LISTER)
    private readonly lister: ConversationMediaLister | null = null,
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

    // S2 first: an object nobody owns is the oldest debt.
    const intents = await this.settleIntents(
      CONVERSATION_RETENTION_LIMITS.intentBatch,
      runStartedAt,
    );
    const media = await this.purgeMedia(mediaBatch, runStartedAt);
    const messages = await this.deleteMessages(batchSize);

    return {
      mediaClaimed: media.claimed,
      mediaPurged: media.purged,
      mediaFailed: media.failed,
      messagesDeleted: messages.deleted,
      conversationsDeleted: messages.conversationsDeleted,
      intentsSettled: intents.settled,
      intentsFailed: intents.failed,
      // A full batch of files that ALL failed is not progress: counting it would
      // make the scheduler retry the same broken rows on every tick.
      hasMore:
        (media.claimed >= mediaBatch && media.purged > 0) ||
        (intents.claimed >= CONVERSATION_RETENTION_LIMITS.intentBatch &&
          intents.settled > 0) ||
        messages.deleted >= batchSize,
    };
  }

  // ------------------------------------------------- S2: unowned objects

  /**
   * Reconciles the media intents that are due (see the migration):
   *   UPLOAD       a media row exists for the id -> the upload finished, drop the
   *                intent (the row owns the object and retention purges it);
   *                no row -> the upload died: delete the object, then the intent.
   *   ROW_DELETED  the row is gone (tenant deletion): delete the object, then
   *                the intent.
   * A failed delete keeps the intent (`attempts`, `lastErrorAt`) and is retried
   * by a later run, after the rows never tried, so one stuck object cannot
   * starve the rest. Deleting a missing object succeeds. Only keys inside the
   * row's own tenant prefix are ever deleted.
   */
  private async settleIntents(batch: number, runStartedAt: Date) {
    const claimed = await this.prisma.$queryRaw<ClaimedIntent[]>(Prisma.sql`
      UPDATE "conversation_media_intents" i
      SET "leaseUntil" = now() + (${CONVERSATION_RETENTION_LIMITS.leaseMinutes} * interval '1 minute')
      WHERE i."id" IN (
        SELECT "id" FROM "conversation_media_intents"
        WHERE "dueAt" < now()
          AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
          AND ("lastErrorAt" IS NULL OR "lastErrorAt" < ${runStartedAt})
        ORDER BY "attempts", "dueAt", "id"
        LIMIT ${batch} FOR UPDATE SKIP LOCKED)
      RETURNING i."id", i."tenantId", i."storageKey", i."reason"`);

    let settled = 0;
    let failed = 0;
    for (const intent of claimed) {
      const prefix = `conversation-media/${intent.tenantId}/`;
      if (!intent.storageKey.startsWith(prefix)) {
        // Never delete an object this row does not own; the row is useless.
        this.logger.error(
          `Conversation media intent ${intent.id} has no key inside its tenant prefix; dropped`,
        );
        await this.dropIntent(intent.id);
        continue;
      }
      try {
        if (
          intent.reason === 'UPLOAD' &&
          (await this.mediaRowExists(intent.id))
        ) {
          await this.dropIntent(intent.id);
          settled += 1;
          continue;
        }
        await this.storage.remove(intent.storageKey);
      } catch (error) {
        this.logger.warn(
          `Conversation media intent ${intent.id} not settled, will retry (${error instanceof Error ? error.name : 'error'})`,
        );
        await this.recordIntentFailure(intent.id, runStartedAt);
        failed += 1;
        continue;
      }
      await this.dropIntent(intent.id);
      settled += 1;
    }
    if (settled > 0 || failed > 0) {
      this.logger.log(
        `Conversation media intents: claimed=${claimed.length} settled=${settled} failed=${failed}`,
      );
    }
    return { claimed: claimed.length, settled, failed };
  }

  private async mediaRowExists(id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "conversation_media" WHERE "id" = ${id}`,
    );
    return rows.length > 0;
  }

  private async dropIntent(id: string): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM "conversation_media_intents" WHERE "id" = ${id}`,
    );
  }

  private async recordIntentFailure(
    id: string,
    runStartedAt: Date,
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "conversation_media_intents"
      SET "attempts" = "attempts" + 1, "lastErrorAt" = ${runStartedAt}, "leaseUntil" = NULL
      WHERE "id" = ${id}`);
  }

  /**
   * The safety net under the intents: objects under `conversation-media/` that
   * no media row and no intent own (made before the intents existed, or by a bug)
   * are deleted once they are a day old. Bounded and resumable: at most
   * `orphanPagesPerRun` pages of `orphanPageSize` keys per call, the position
   * kept in `conversation_media_orphan_sweep` (a lease keeps replicas on
   * different pages) so a deploy never restarts the pass. Prefix-guarded twice:
   * the listing is `conversation-media/` only and an object is touched only when
   * its name has exactly the shape this module writes. An object is an orphan
   * when its media id has no row that names this very object and no intent.
   * Without a lister (no listing capability configured) it does nothing.
   */
  async sweepOrphans(
    input: { now?: Date; maxPages?: number } = {},
  ): Promise<OrphanSweepResult> {
    const result: OrphanSweepResult = {
      scanned: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      passCompleted: false,
    };
    if (!this.lister) return result;
    const now = input.now ?? new Date();
    const maxPages =
      input.maxPages ?? CONVERSATION_RETENTION_LIMITS.orphanPagesPerRun;
    const cutoff = new Date(
      now.getTime() -
        CONVERSATION_RETENTION_LIMITS.orphanGraceHours * 3_600_000,
    );

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "conversation_media_orphan_sweep" ("id") VALUES ('conversation-media')
      ON CONFLICT ("id") DO NOTHING`);
    const claimed = await this.prisma.$queryRaw<
      Array<{ cursor: string | null }>
    >(Prisma.sql`
      UPDATE "conversation_media_orphan_sweep"
      SET "leaseUntil" = now() + (${CONVERSATION_RETENTION_LIMITS.leaseMinutes} * interval '1 minute')
      WHERE "id" = 'conversation-media'
        AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
      RETURNING "cursor"`);
    if (claimed.length === 0) return result; // another replica is on it
    let position = claimed[0].cursor;

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const listed = await this.lister.list({
          prefix: CONVERSATION_MEDIA_PREFIX,
          startAfter: position,
          limit: CONVERSATION_RETENTION_LIMITS.orphanPageSize,
        });
        result.scanned += listed.objects.length;
        await this.sweepPage(listed.objects, cutoff, result);
        const names = listed.objects.map((o) => o.key);
        const lastName = names[names.length - 1];
        position = listed.truncated && lastName ? lastName : null;
        await this.saveOrphanPosition(position, true);
        if (position === null) {
          result.passCompleted = true;
          break;
        }
      }
    } catch (error) {
      this.logger.error(
        `Conversation media orphan sweep failed (${error instanceof Error ? error.name : 'unknown'})`,
      );
    } finally {
      await this.saveOrphanPosition(position, false);
    }
    if (result.deleted > 0 || result.failed > 0) {
      this.logger.log(
        `Conversation media orphan sweep: scanned=${result.scanned} deleted=${result.deleted} failed=${result.failed} skipped=${result.skipped}`,
      );
    }
    return result;
  }

  private async saveOrphanPosition(
    position: string | null,
    keepLease: boolean,
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "conversation_media_orphan_sweep"
      SET "cursor" = ${position}, "updatedAt" = now(),
          "leaseUntil" = ${keepLease ? Prisma.sql`"leaseUntil"` : Prisma.sql`NULL`}
      WHERE "id" = 'conversation-media'`);
  }

  private async sweepPage(
    objects: Array<{ key: string; lastModified: Date | null }>,
    cutoff: Date,
    result: OrphanSweepResult,
  ): Promise<void> {
    const candidates: Array<{ name: string; tenantId: string; id: string }> =
      [];
    for (const object of objects) {
      const match = MEDIA_KEY.exec(object.key);
      if (!match) {
        result.skipped += 1;
        continue;
      }
      // Unknown age, or too young to tell from an upload in flight.
      if (!object.lastModified || object.lastModified >= cutoff) continue;
      candidates.push({ name: object.key, tenantId: match[1], id: match[2] });
    }
    if (candidates.length === 0) return;
    const ids = candidates.map((c) => c.id);
    const [rows, intents] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ id: string; tenantId: string; storageKey: string | null }>
      >(Prisma.sql`
        SELECT "id", "tenantId", "storageKey" FROM "conversation_media"
        WHERE "id" = ANY(${ids}::text[])`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "conversation_media_intents"
        WHERE "id" = ANY(${ids}::text[])`),
    ]);
    const owned = new Set(
      rows
        .filter((r) => r.storageKey !== null)
        .map((r) => `${r.tenantId}|${r.storageKey}`),
    );
    const pending = new Set(intents.map((i) => i.id));
    for (const candidate of candidates) {
      if (pending.has(candidate.id)) continue;
      if (owned.has(`${candidate.tenantId}|${candidate.name}`)) continue;
      try {
        await this.storage.remove(candidate.name);
        result.deleted += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Conversation media orphan not deleted, found again on the next pass (${error instanceof Error ? error.name : 'error'})`,
        );
      }
    }
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
          -- N3: staff reach a chat only through a request, and the FE keeps its
          -- paging cursor (a seq) per request. A chat some request points at
          -- keeps its row so nextSeq never restarts under a held cursor; only
          -- chats no request ever referenced (nobody can hold a cursor) go.
          AND NOT EXISTS (
            SELECT 1 FROM "chatbot_requests" r
            WHERE r."tenantId" = k."tenantId" AND r."conversationRef" = k."conversationRef")
        FOR UPDATE SKIP LOCKED)`);
  }
}
