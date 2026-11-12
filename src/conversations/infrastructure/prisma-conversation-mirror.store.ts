/**
 * Prisma adapter of the conversation mirror writes (unit 9). Every statement
 * names `tenantId` (from CLS, set by the bot guard) and runs in ONE transaction:
 *
 *   1. upsert the chat row (`ON CONFLICT … DO UPDATE` takes its row lock, so two
 *      batches of one chat run one after the other; `seq` needs no other lock);
 *   2. drop the ids that are already mirrored (a duplicate in ANOTHER chat is a
 *      409: the bot reused a wamid);
 *   3. check the referenced files (same tenant, not purged, right kind);
 *   4. insert with `seq = nextSeq + i` in array order and advance `nextSeq`;
 *   5. write `conversation.message` events (last: the realtime advisory lock is
 *      the final lock of the transaction, as the unit 8 rules require).
 *
 * A rolled-back batch burns no `seq` and writes no event. Lock order with the
 * rest of the system: this transaction takes the chat row, then the realtime
 * tenant lock; request commands take the request row, then (at commit) the
 * realtime lock; neither takes the other's first lock, so there is no cycle.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ChatbotRequestCommandError } from '../../chatbot-requests/application/chatbot-request-commands.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  emitRealtimeEvents,
  type RealtimeEventDraft,
} from '../../shared/realtime/realtime-event-writes';
import type {
  ConversationMirrorStore,
  IngestResult,
  StatusResult,
} from '../application/conversation-mirror.service';
import type {
  ParsedMessage,
  ParsedStatus,
} from '../domain/conversation-message';
import { mediaMatchesMessageType } from '../domain/conversation-media';
import {
  canAdvanceDeliveryStatus,
  initialDeliveryStatus,
} from '../domain/delivery-status';

/** The chat's open requests that get a realtime event (the open limit is 20). */
const OPEN_REQUESTS_PER_CHAT = 20;

type Db = ReturnType<TenantPrismaService['getClient']>;

/** Open requests of one chat (by `conversationRef`), oldest first. */
async function openRequestIds(
  db: Db,
  tenantId: string,
  conversationRef: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "conversationRef" = ${conversationRef}
      AND "status" IN ('NEW', 'IN_PROGRESS')
    ORDER BY "createdAt", "id" LIMIT ${OPEN_REQUESTS_PER_CHAT}`);
  return rows.map((r) => r.id);
}

@Injectable()
export class PrismaConversationMirrorStore implements ConversationMirrorStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  ingest(input: {
    conversationRef: string;
    customerKey: string | null;
    messages: ParsedMessage[];
  }): Promise<IngestResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const [chat] = await db.$queryRaw<
        Array<{
          id: string;
          nextSeq: number;
          lastCustomerMessageAt: Date | null;
        }>
      >(Prisma.sql`
        INSERT INTO "chatbot_conversations"
          ("id", "tenantId", "conversationRef", "customerKey", "updatedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${input.conversationRef}, ${input.customerKey}, now())
        ON CONFLICT ("tenantId", "conversationRef")
          DO UPDATE SET "updatedAt" = now()
        RETURNING "id", "nextSeq", "lastCustomerMessageAt"`);

      const ids = input.messages.map((m) => m.waMessageId);
      const existing = await db.$queryRaw<
        Array<{ waMessageId: string; conversationId: string }>
      >(Prisma.sql`
        SELECT "waMessageId", "conversationId" FROM "conversation_messages"
        WHERE "tenantId" = ${tenantId} AND "waMessageId" = ANY(${ids}::text[])`);
      if (existing.some((row) => row.conversationId !== chat.id)) {
        throw new ChatbotRequestCommandError('MESSAGE_ID_CONFLICT', 409);
      }
      const known = new Set(existing.map((row) => row.waMessageId));
      const fresh = input.messages.filter((m) => !known.has(m.waMessageId));
      const duplicates = input.messages
        .filter((m) => known.has(m.waMessageId))
        .map((m) => m.waMessageId);
      if (fresh.length === 0) return { accepted: [], duplicates };

      await this.assertMedia(db, tenantId, fresh);

      const stored = fresh.map((message, i) => ({
        message,
        id: randomUUID(),
        seq: chat.nextSeq + i,
      }));
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author",
           "waMessageId", "type", "text", "mediaId", "providerTimestamp",
           "observedAt", "receivedAt", "deliveryStatus", "purgeAfter")
        VALUES ${Prisma.join(
          stored.map(
            ({ message: m, id, seq }) => Prisma.sql`(
              ${id}, ${tenantId}, ${chat.id}, ${seq},
              ${m.direction}::"ConversationMessageDirection",
              ${m.author}::"ConversationMessageAuthor",
              ${m.waMessageId}, ${m.type}::"ConversationMessageType", ${m.text},
              ${m.mediaId}, ${m.providerTimestamp}, ${m.observedAt}, now(),
              ${initialDeliveryStatus(m.direction, m.author)}::"ConversationDeliveryStatus",
              now() + interval '12 months')`,
          ),
        )}`);

      const latestCustomer = stored
        .filter(({ message }) => message.direction === 'IN')
        .reduce<Date | null>(
          (latest, { message }) =>
            !latest || message.providerTimestamp > latest
              ? message.providerTimestamp
              : latest,
          chat.lastCustomerMessageAt,
        );
      await db.$executeRaw(Prisma.sql`
        UPDATE "chatbot_conversations"
        SET "nextSeq" = ${chat.nextSeq + stored.length},
            "lastCustomerMessageAt" = ${latestCustomer}, "updatedAt" = now()
        WHERE "id" = ${chat.id}`);

      const requestIds = await openRequestIds(
        db,
        tenantId,
        input.conversationRef,
      );
      const drafts: RealtimeEventDraft[] = stored.flatMap(({ id, seq }) =>
        requestIds.map((requestId) => ({
          tenantId,
          userId: null,
          type: 'conversation.message',
          requestId,
          payload: { messageId: id, seq },
        })),
      );
      await emitRealtimeEvents(db, drafts);

      return {
        accepted: stored.map(({ message, id, seq }) => ({
          waMessageId: message.waMessageId,
          messageId: id,
          seq,
        })),
        duplicates,
      };
    });
  }

  private async assertMedia(
    db: Db,
    tenantId: string,
    messages: ParsedMessage[],
  ): Promise<void> {
    const wanted = messages.filter((m) => m.mediaId !== null);
    if (wanted.length === 0) return;
    const rows = await db.$queryRaw<
      Array<{ id: string; mimeType: string; purgedAt: Date | null }>
    >(Prisma.sql`
      SELECT "id", "mimeType", "purgedAt" FROM "conversation_media"
      WHERE "tenantId" = ${tenantId}
        AND "id" = ANY(${wanted.map((m) => m.mediaId as string)}::text[])`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const message of wanted) {
      const media = byId.get(message.mediaId as string);
      if (!media || media.purgedAt) {
        throw new ChatbotRequestCommandError('MEDIA_NOT_FOUND', 422);
      }
      if (!mediaMatchesMessageType(message.type, media.mimeType)) {
        throw new ChatbotRequestCommandError('MEDIA_TYPE_MISMATCH', 422);
      }
    }
  }

  applyStatuses(statuses: ParsedStatus[]): Promise<StatusResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const ids = [...new Set(statuses.map((s) => s.providerMessageId))];
      // Locked in id order so two status batches never wait on each other in a
      // cycle.
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          seq: number;
          conversationId: string;
          waMessageId: string;
          direction: string;
          deliveryStatus: string | null;
        }>
      >(Prisma.sql`
        SELECT "id", "seq", "conversationId", "waMessageId",
               "direction"::text AS "direction", "deliveryStatus"::text AS "deliveryStatus"
        FROM "conversation_messages"
        WHERE "tenantId" = ${tenantId} AND "waMessageId" = ANY(${ids}::text[])
        ORDER BY "id" FOR UPDATE`);
      const byWamid = new Map(rows.map((row) => [row.waMessageId, row]));
      const current = new Map(rows.map((row) => [row.id, row.deliveryStatus]));

      let applied = 0;
      let ignored = 0;
      const unknown = new Set<string>();
      // Statuses arrive out of order and repeated: fold them in the order the
      // bot sent them, each only if it moves the message forward.
      for (const status of statuses) {
        const row = byWamid.get(status.providerMessageId);
        if (!row) {
          unknown.add(status.providerMessageId);
          continue;
        }
        if (
          row.direction === 'OUT' &&
          canAdvanceDeliveryStatus(current.get(row.id) ?? null, status.status)
        ) {
          current.set(row.id, status.status);
          applied += 1;
        } else {
          ignored += 1;
        }
      }

      const changed = rows.filter(
        (row) => current.get(row.id) !== row.deliveryStatus,
      );
      if (changed.length > 0) {
        await db.$executeRaw(Prisma.sql`
          UPDATE "conversation_messages" AS m
          SET "deliveryStatus" = v."status"::"ConversationDeliveryStatus"
          FROM (VALUES ${Prisma.join(
            changed.map(
              (row) => Prisma.sql`(${row.id}, ${current.get(row.id)})`,
            ),
          )}) AS v("id", "status")
          WHERE m."id" = v."id" AND m."tenantId" = ${tenantId}`);
        const targets = await db.$queryRaw<
          Array<{ messageId: string; requestId: string }>
        >(Prisma.sql`
          SELECT m."id" AS "messageId", r."id" AS "requestId"
          FROM "conversation_messages" m
          JOIN "chatbot_conversations" c
            ON c."tenantId" = m."tenantId" AND c."id" = m."conversationId"
          JOIN "chatbot_requests" r
            ON r."tenantId" = c."tenantId" AND r."conversationRef" = c."conversationRef"
           AND r."status" IN ('NEW', 'IN_PROGRESS')
          WHERE m."tenantId" = ${tenantId}
            AND m."id" = ANY(${changed.map((row) => row.id)}::text[])
          ORDER BY m."seq", r."createdAt", r."id"`);
        const meta = new Map(changed.map((row) => [row.id, row]));
        await emitRealtimeEvents(
          db,
          targets.map(({ messageId, requestId }) => ({
            tenantId,
            userId: null,
            type: 'message.status',
            requestId,
            payload: {
              messageId,
              seq: meta.get(messageId)?.seq ?? 0,
              deliveryStatus: current.get(messageId) ?? null,
            },
          })),
        );
      }
      return { applied, ignored, unknown: [...unknown] };
    });
  }
}
