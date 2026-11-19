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
import {
  WINDOW_CLOSED_ERROR_CODE,
  type ParsedMessage,
  type ParsedStatus,
} from '../domain/conversation-message';
import { mediaMatchesMessageType } from '../domain/conversation-media';
import {
  canAdvanceDeliveryStatus,
  initialDeliveryStatus,
} from '../domain/delivery-status';
import { openRequestIds } from './open-request-ids';

/** PostgreSQL `unique_violation`, as Prisma reports it for a raw statement. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
  return (
    meta?.code === '23505' ||
    (typeof meta?.message === 'string' && meta.message.includes('23505'))
  );
}

type Db = ReturnType<TenantPrismaService['getClient']>;

/** The backend's own record of a staff reply (never the bot's words). */
interface StaffReply {
  replyId: string;
  requestId: string;
  staffUserId: string;
  /** The exact text the staff member submitted (`resolution.text`). */
  text: string;
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
          mode: 'BOT' | 'HUMAN';
          handoffEpoch: number;
        }>
      >(Prisma.sql`
        INSERT INTO "chatbot_conversations"
          ("id", "tenantId", "conversationRef", "customerKey", "updatedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${input.conversationRef}, ${input.customerKey}, now())
        ON CONFLICT ("tenantId", "conversationRef")
          DO UPDATE SET "updatedAt" = now()
        RETURNING "id", "nextSeq", "lastCustomerMessageAt",
                  "mode"::text AS "mode", "handoffEpoch"`);

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
      const handoff = { mode: chat.mode, handoffEpoch: chat.handoffEpoch };
      if (fresh.length === 0) return { accepted: [], duplicates, ...handoff };

      await this.assertMedia(db, tenantId, fresh);
      const replies = await this.resolveReplies(
        db,
        tenantId,
        input.conversationRef,
        fresh,
      );

      const stored = fresh.map((message, i) => {
        const reply = message.staffReplyId
          ? replies.get(message.staffReplyId)
          : undefined;
        return {
          message,
          // Unit 10: a staff reply keeps its own id (the audit's message id).
          id: reply ? reply.replyId : randomUUID(),
          seq: chat.nextSeq + i,
          reply,
        };
      });
      try {
        await db.$executeRaw(Prisma.sql`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author",
           "staffUserId", "clientMessageId",
           "waMessageId", "type", "text", "mediaId", "providerTimestamp",
           "observedAt", "receivedAt", "deliveryStatus", "purgeAfter")
        VALUES ${Prisma.join(
          stored.map(
            ({ message: m, id, seq, reply }) => Prisma.sql`(
              ${id}, ${tenantId}, ${chat.id}, ${seq},
              ${m.direction}::"ConversationMessageDirection",
              ${reply ? 'STAFF' : m.author}::"ConversationMessageAuthor",
              ${reply ? reply.staffUserId : null},
              ${reply ? reply.replyId : null},
              ${m.waMessageId}, ${m.type}::"ConversationMessageType",
              ${reply ? reply.text : m.text},
              ${m.mediaId}, ${m.providerTimestamp}, ${m.observedAt}, now(),
              ${initialDeliveryStatus(m.direction, reply ? 'BOT' : m.author)}::"ConversationDeliveryStatus",
              now() + interval '12 months')`,
          ),
        )}`);
      } catch (error) {
        // Two chats of one tenant that post the same wamid at the same moment
        // both pass the check above; the unique index decides. The loser is the
        // same 409 the sequential case gets (the transaction is aborted, so
        // nothing of this batch is stored).
        if (isUniqueViolation(error)) {
          throw new ChatbotRequestCommandError('MESSAGE_ID_CONFLICT', 409);
        }
        throw error;
      }

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
      // Unit 10: a staff reply closed its own request, which is no longer
      // "open" but is the one its author is looking at, so it hears of the
      // message too.
      const drafts: RealtimeEventDraft[] = stored.flatMap(
        ({ id, seq, reply }) =>
          (reply && !requestIds.includes(reply.requestId)
            ? [reply.requestId, ...requestIds]
            : requestIds
          ).map((requestId) => ({
            tenantId,
            userId: null,
            type: 'conversation.message',
            requestId,
            payload: { messageId: id, seq },
          })),
      );
      // S12: a customer message changes `unreadCustomerMessages` of every open
      // request of the chat, so each gets ONE `request.updated` per batch (the
      // row is built at delivery and carries the new count). Bot-only batches
      // change no count and send none.
      if (stored.some(({ message }) => message.direction === 'IN')) {
        for (const requestId of requestIds) {
          drafts.push({
            tenantId,
            userId: null,
            type: 'request.updated',
            requestId,
            payload: { cause: 'CUSTOMER_MESSAGE' },
          });
        }
      }
      await emitRealtimeEvents(db, drafts);

      return {
        accepted: stored.map(({ message, id, seq }) => ({
          waMessageId: message.waMessageId,
          messageId: id,
          seq,
        })),
        duplicates,
        ...handoff,
      };
    });
  }

  /**
   * Unit 10: the staff replies the bot says it sent. A `staffReplyId` must be
   * the id of a RESOLVED clarification of THIS tenant; the staff user comes
   * from the backend's own record (`resolvedByActorId`), never from the batch,
   * and so does the TEXT (`resolution.text`, exactly what the staff member
   * submitted): the text the bot sent with the message is not stored, so the
   * bot credential cannot put arbitrary words in a named staff member's mouth.
   * A request that carries a `conversationRef` only matches its own chat. A
   * request WITHOUT one (the bot never told us its chat) matches the chat the
   * bot sent the reply to: the reply id is the message's primary key, so it can
   * be mirrored once, and a second mirror in another chat is
   * `409 MESSAGE_ID_CONFLICT`. An unknown, foreign or other-chat id is a bug in
   * the bot: the whole batch is refused (`422 REPLY_NOT_FOUND`), never mirrored
   * as the bot's.
   */
  private async resolveReplies(
    db: Db,
    tenantId: string,
    conversationRef: string,
    messages: ParsedMessage[],
  ): Promise<Map<string, StaffReply>> {
    const wanted = messages.flatMap((m) =>
      m.staffReplyId ? [m.staffReplyId] : [],
    );
    const found = new Map<string, StaffReply>();
    if (wanted.length === 0) return found;
    const rows = await db.$queryRaw<
      Array<{
        replyId: string;
        requestId: string;
        staffUserId: string | null;
        text: string | null;
        conversationRef: string | null;
      }>
    >(Prisma.sql`
      SELECT "resolution" ->> 'replyId' AS "replyId", "id" AS "requestId",
             "resolvedByActorId" AS "staffUserId",
             "resolution" ->> 'text' AS "text", "conversationRef"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId}
        AND "kind" = 'CLARIFICATION' AND "status" = 'RESOLVED'
        AND "resolution" ->> 'replyId' = ANY(${wanted}::text[])`);
    for (const row of rows) {
      if (
        (row.conversationRef === null ||
          row.conversationRef === conversationRef) &&
        row.staffUserId &&
        row.text !== null
      ) {
        found.set(row.replyId, {
          replyId: row.replyId,
          requestId: row.requestId,
          staffUserId: row.staffUserId,
          text: row.text,
        });
      }
    }
    if (wanted.some((id) => !found.has(id))) {
      throw new ChatbotRequestCommandError('REPLY_NOT_FOUND', 422);
    }
    return found;
  }

  private async assertMedia(
    db: Db,
    tenantId: string,
    messages: ParsedMessage[],
  ): Promise<void> {
    const wanted = messages.filter((m) => m.mediaId !== null);
    if (wanted.length === 0) return;
    // N4. The rows are LOCKED (`FOR UPDATE`, in id order so two batches never
    // wait on each other in a cycle): the retention claim skips a locked row, so
    // a purge cannot start on a file this batch is about to reference. A file
    // that is already due, or that a purge has claimed (lease), cannot be
    // referenced any more: the message would point at a file being deleted.
    const rows = await db.$queryRaw<
      Array<{
        id: string;
        mimeType: string;
        purgedAt: Date | null;
        referenceable: boolean;
        purgeAfter: Date;
      }>
    >(Prisma.sql`
      SELECT "id", "mimeType", "purgedAt", "purgeAfter",
             ("purgedAt" IS NULL AND "purgeAfter" > now()
              AND ("purgeLeaseUntil" IS NULL OR "purgeLeaseUntil" < now())) AS "referenceable"
      FROM "conversation_media"
      WHERE "tenantId" = ${tenantId}
        AND "id" = ANY(${wanted.map((m) => m.mediaId as string)}::text[])
      ORDER BY "id" FOR UPDATE`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const message of wanted) {
      const media = byId.get(message.mediaId as string);
      if (!media || media.purgedAt || !media.referenceable) {
        throw new ChatbotRequestCommandError('MEDIA_NOT_FOUND', 422);
      }
      if (!mediaMatchesMessageType(message.type, media.mimeType)) {
        throw new ChatbotRequestCommandError('MEDIA_TYPE_MISMATCH', 422);
      }
    }
    // A file is purged when the LAST message that shows it is due: its purge
    // time is the latest `purgeAfter` of its references (the messages of this
    // batch are stamped `now() + 12 months`).
    await db.$executeRaw(Prisma.sql`
      UPDATE "conversation_media"
      SET "purgeAfter" = now() + interval '12 months'
      WHERE "tenantId" = ${tenantId}
        AND "id" = ANY(${[...byId.keys()]}::text[])
        AND "purgeAfter" < now() + interval '12 months'`);
  }

  /**
   * S16 4: the staff-message feed items behind the `FAILED 131047` statuses of
   * a batch, keyed by message id, locked in cursor order. Empty when the batch
   * has none (no extra query).
   */
  private async lockWindowClosedItems(
    db: ReturnType<TenantPrismaService['getClient']>,
    tenantId: string,
    statuses: ParsedStatus[],
  ): Promise<
    Map<string, { cursor: bigint; requestId: string; epoch: number }>
  > {
    const wamids = [
      ...new Set(
        statuses
          .filter(
            (s) =>
              s.status === 'FAILED' && s.errorCode === WINDOW_CLOSED_ERROR_CODE,
          )
          .map((s) => s.providerMessageId),
      ),
    ];
    if (wamids.length === 0) return new Map();
    const staff = await db.$queryRaw<
      Array<{ id: string; conversationRef: string }>
    >(Prisma.sql`
      SELECT m."id", c."conversationRef"
      FROM "conversation_messages" m
      JOIN "chatbot_conversations" c
        ON c."tenantId" = m."tenantId" AND c."id" = m."conversationId"
      WHERE m."tenantId" = ${tenantId} AND m."waMessageId" = ANY(${wamids}::text[])
        AND m."author" = 'STAFF' AND m."direction" = 'OUT'`);
    if (staff.length === 0) return new Map();
    const items = await db.$queryRaw<
      Array<{
        cursor: bigint;
        messageId: string;
        requestId: string;
        epoch: number;
      }>
    >(Prisma.sql`
      SELECT f."cursor", f."payload"->>'messageId' AS "messageId", f."requestId",
             (f."payload"->>'handoffEpoch')::int AS "epoch"
      FROM "chatbot_feed_items" f
      WHERE f."tenantId" = ${tenantId}
        AND f."conversationRef" = ANY(${[...new Set(staff.map((m) => m.conversationRef))]}::text[])
        AND f."type" = 'conversation.staff_message'
        AND f."payload"->>'messageId' = ANY(${staff.map((m) => m.id)}::text[])
      ORDER BY f."cursor"
      FOR UPDATE`);
    return new Map(
      items.map((i) => [
        i.messageId,
        { cursor: i.cursor, requestId: i.requestId, epoch: i.epoch },
      ]),
    );
  }

  /** The item's own epoch is still an ACTIVE session (it can be resent). */
  private async epochIsActive(
    db: ReturnType<TenantPrismaService['getClient']>,
    tenantId: string,
    item: { requestId: string; epoch: number },
  ): Promise<boolean> {
    const [row] = await db.$queryRaw<Array<{ one: number }>>(Prisma.sql`
      SELECT 1 AS "one" FROM "chatbot_live_sessions"
      WHERE "tenantId" = ${tenantId} AND "requestId" = ${item.requestId}
        AND "epoch" = ${item.epoch} AND "state" = 'ACTIVE'`);
    return row !== undefined;
  }

  applyStatuses(statuses: ParsedStatus[]): Promise<StatusResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const ids = [...new Set(statuses.map((s) => s.providerMessageId))];
      // S16 4: a FAILED 131047 on a staff message is a closed window. Its feed
      // item is locked BEFORE the message rows (the ACK of the same delivery
      // locks item then message), never after.
      const windowClosed = await this.lockWindowClosedItems(
        db,
        tenantId,
        statuses,
      );
      // Lock order (verify F2): item → chat → message, the order of the ACK
      // (`applyStaffMessageOutcome`), the sweep and the finish. The chats of the
      // batch are locked in id order BEFORE the message rows: the reopened-window
      // write below used to take the chat while holding the messages, a cycle
      // with the idle sweep (chat, then message).
      await db.$queryRaw(Prisma.sql`
        SELECT c."id" FROM "chatbot_conversations" c
        WHERE c."tenantId" = ${tenantId}
          AND c."id" IN (
            SELECT m."conversationId" FROM "conversation_messages" m
            WHERE m."tenantId" = ${tenantId}
              AND m."waMessageId" = ANY(${ids}::text[]))
        ORDER BY c."id" FOR UPDATE`);
      // Locked in id order so two status batches never wait on each other in a
      // cycle.
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          seq: number;
          conversationId: string;
          waMessageId: string;
          direction: string;
          author: string;
          deliveryStatus: string | null;
        }>
      >(Prisma.sql`
        SELECT "id", "seq", "conversationId", "waMessageId",
               "direction"::text AS "direction", "author"::text AS "author",
               "deliveryStatus"::text AS "deliveryStatus"
        FROM "conversation_messages"
        WHERE "tenantId" = ${tenantId} AND "waMessageId" = ANY(${ids}::text[])
        ORDER BY "id" FOR UPDATE`);
      const byWamid = new Map(rows.map((row) => [row.waMessageId, row]));
      const current = new Map(rows.map((row) => [row.id, row.deliveryStatus]));

      let applied = 0;
      let ignored = 0;
      const unknown = new Set<string>();
      const reopened: Array<{
        cursor: bigint;
        conversationId: string;
        at: Date;
      }> = [];
      // Statuses arrive out of order and repeated: fold them in the order the
      // bot sent them, each only if it moves the message forward.
      for (const status of statuses) {
        const row = byWamid.get(status.providerMessageId);
        if (!row) {
          unknown.add(status.providerMessageId);
          continue;
        }
        const item = windowClosed.get(row.id);
        if (
          item &&
          status.errorCode === WINDOW_CLOSED_ERROR_CODE &&
          current.get(row.id) === 'SENT'
        ) {
          // The window is closed, not the message: it waits for the customer
          // while its session is ACTIVE, and is terminal once it is not.
          const waits = await this.epochIsActive(db, tenantId, item);
          current.set(row.id, waits ? 'DEFERRED' : 'FAILED');
          if (waits) {
            reopened.push({
              cursor: item.cursor,
              conversationId: row.conversationId,
              at: status.occurredAt,
            });
          }
          applied += 1;
        } else if (
          status.errorCode === WINDOW_CLOSED_ERROR_CODE &&
          current.get(row.id) === 'DEFERRED'
        ) {
          // A replayed window verdict on a message already waiting for the
          // customer changes nothing (it must not turn it FAILED).
          ignored += 1;
        } else if (
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
        for (const { cursor, conversationId, at } of reopened) {
          // The delivery is pending again (the bot resends it, in seq order,
          // with a new attempt) and Meta's verdict corrects the chat's window:
          // closed from `at` until the customer's next message.
          await db.$executeRaw(Prisma.sql`
            UPDATE "chatbot_feed_items"
            SET "outcome" = 'DEFERRED_WINDOW_CLOSED', "ackedAt" = NULL
            WHERE "tenantId" = ${tenantId} AND "cursor" = ${cursor}`);
          await db.$executeRaw(Prisma.sql`
            UPDATE "chatbot_conversations"
            SET "windowClosedAt" = ${at}, "updatedAt" = now()
            WHERE "tenantId" = ${tenantId} AND "id" = ${conversationId}
              AND ("windowClosedAt" IS NULL OR "windowClosedAt" < ${at})`);
        }
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
