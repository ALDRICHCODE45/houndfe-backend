/**
 * The live conversation's request-path writes (human-intervention unit 11;
 * contract §4.3, §4.4, §12.15): the bot's `session-ack`, its `state` read and
 * the attendee's messages. Everything runs on the tenant-scoped client (the
 * tenant comes from CLS: the bot guard or the staff guards) and in ONE
 * transaction, in the lock order of §6.5: request row, conversation row, feed
 * advisory lock, realtime lock last.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import { actorDisplayName } from '../domain/actor-display-name';
import {
  buildStaffMessagePayload,
  buildTemplateRequestedPayload,
  FEED_TYPE,
} from '../domain/chatbot-feed';
import {
  decideSessionAck,
  staffFirstName,
  type StaffMessageContent,
  whatsappWindowClosesAt,
} from '../domain/live-session';
import { mediaMatchesMessageType } from '../../conversations/domain/conversation-media';
import { insertFeedItems } from './chatbot-feed-writes';
import { readSettingsRow } from './chatbot-sla-policy';
import { lockRequestRow, type TenantClient } from './chatbot-request-writes';
import {
  bumpVersion,
  emitSessionEvent,
  failDeferredStaffMessages,
  lockConversation,
  lockLatestSession,
  markActive,
  markEnded,
  type LiveSessionRow,
} from './live-session-writes';
import { emitRealtimeEvents } from '../../shared/realtime/realtime-event-writes';

export interface SessionAckResult {
  epoch: number;
  state: 'STARTED' | 'ENDED';
  sessionState: string;
}

export interface StaffMessageResult {
  message: {
    id: string;
    seq: number;
    direction: 'OUT';
    author: 'STAFF';
    type: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'TEMPLATE';
    /** The text, or the caption of a media message (`''` when none). */
    text: string;
    /** TEMPLATE only: the approved template the tenant's settings name. */
    templateName?: string;
    /** IMAGE/DOCUMENT only. */
    media?: { id: string; mimeType: string; filename: string | null };
    deliveryStatus: string;
    clientMessageId: string;
    staff: { id: string; displayName: string };
    createdAt: string;
  };
}

interface StoredMedia {
  id: string;
  mimeType: string;
  filename: string | null;
}

const MAX_ACK_ATTEMPTS = 3;

@Injectable()
export class PrismaLiveConversationStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** §4.3, §12.15, §4.1: the bot's confirmation that it muted or unmuted. */
  async sessionAck(
    conversationRef: string,
    epoch: number,
    state: 'STARTED' | 'ENDED',
  ): Promise<SessionAckResult> {
    for (let attempt = 0; attempt < MAX_ACK_ATTEMPTS; attempt++) {
      const result = await this.tryAck(conversationRef, epoch, state);
      if (result !== 'RETRY') return result;
    }
    throw new ChatbotRequestCommandError('VERSION_CONFLICT', 409);
  }

  private tryAck(
    conversationRef: string,
    epoch: number,
    state: 'STARTED' | 'ENDED',
  ): Promise<SessionAckResult | 'RETRY'> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      const [peek] = await tx.$queryRaw<
        { requestId: string | null; handoffEpoch: number; mode: string }[]
      >(Prisma.sql`
        SELECT (SELECT s."requestId" FROM "chatbot_live_sessions" s
                WHERE s."tenantId" = c."tenantId" AND s."conversationId" = c."id"
                ORDER BY s."epoch" DESC LIMIT 1) AS "requestId",
               c."handoffEpoch", c."mode"::text AS "mode"
        FROM "chatbot_conversations" c
        WHERE c."tenantId" = ${tenantId} AND c."conversationRef" = ${conversationRef}`);
      if (!peek) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      const stale = (sessionState: string | null) =>
        new ChatbotRequestCommandError('STALE_EPOCH', 409, undefined, {
          currentEpoch: peek.handoffEpoch,
          mode: peek.mode,
          sessionState,
        });
      if (!peek.requestId) throw stale(null);

      // Request row first, then the chat row (§6.5), then the session.
      const request = await lockRequestRow(tx, tenantId, peek.requestId);
      const conversation = await lockConversation(
        tx,
        tenantId,
        conversationRef,
      );
      const [latest] = await tx.$queryRaw<LiveSessionRow[]>(Prisma.sql`
        SELECT s."id", s."requestId", s."conversationId", s."epoch", s."state",
               s."endReason", s."staffUserId", s."startSeq", s."startedAt",
               s."activeAt", s."endingAt"
        FROM "chatbot_live_sessions" s
        WHERE s."tenantId" = ${tenantId} AND s."conversationId" = ${conversation.id}
        ORDER BY s."epoch" DESC LIMIT 1 FOR UPDATE`);
      if (!request || !latest || latest.requestId !== peek.requestId) {
        return 'RETRY';
      }
      const decision = decideSessionAck(latest, epoch, state);
      if (decision === 'STALE_EPOCH') throw stale(latest.state);
      if (decision === 'SESSION_NOT_ENDING') {
        throw new ChatbotRequestCommandError(
          'SESSION_NOT_ENDING',
          409,
          undefined,
          { currentEpoch: latest.epoch, sessionState: latest.state },
        );
      }
      if (decision === 'REPLAY') {
        const current = epoch < latest.epoch ? 'ENDED' : latest.state;
        return { epoch, state, sessionState: current };
      }
      if (state === 'STARTED') {
        await markActive(tx, latest.id);
        const version = await bumpVersion(tx, tenantId, latest.requestId);
        await emitSessionEvent(
          tx,
          tenantId,
          latest.requestId,
          'session.active',
          version,
        );
        return { epoch, state, sessionState: 'ACTIVE' };
      }
      await markEnded(tx, latest);
      // S16 3 (verify F1): a deferral whose ACK committed after the finish
      // skipped its item (SKIP LOCKED) is still pending: settle it now.
      const failed = await failDeferredStaffMessages(
        tx,
        tenantId,
        latest.requestId,
        latest.epoch,
      );
      const version = await bumpVersion(tx, tenantId, latest.requestId);
      await emitSessionEvent(
        tx,
        tenantId,
        latest.requestId,
        'session.ended',
        version,
        failed,
      );
      return { epoch, state, sessionState: 'ENDED' };
    });
  }

  /** §4.7: the bot's reconciliation read. `null`: unknown conversation. */
  async conversationState(conversationRef: string): Promise<{
    mode: 'BOT' | 'HUMAN';
    handoffEpoch: number;
    sessionState: string | null;
    requestId: string | null;
    assigneeFirstName: string | null;
  } | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    const [row] = await tx.$queryRaw<
      {
        mode: 'BOT' | 'HUMAN';
        handoffEpoch: number;
        sessionState: string | null;
        requestId: string | null;
        assigneeDisplayName: string | null;
      }[]
    >(Prisma.sql`
      SELECT c."mode"::text AS "mode", c."handoffEpoch", s."state" AS "sessionState",
             s."requestId", r."assigneeDisplayName"
      FROM "chatbot_conversations" c
      LEFT JOIN LATERAL (
        SELECT s."state", s."requestId" FROM "chatbot_live_sessions" s
        WHERE s."tenantId" = c."tenantId" AND s."conversationId" = c."id"
          AND s."state" <> 'ENDED'
        ORDER BY s."epoch" DESC LIMIT 1) s ON TRUE
      LEFT JOIN "chatbot_requests" r
        ON r."tenantId" = c."tenantId" AND r."id" = s."requestId"
      WHERE c."tenantId" = ${tenantId} AND c."conversationRef" = ${conversationRef}`);
    if (!row) return null;
    const live = row.sessionState !== null;
    return {
      mode: row.mode,
      handoffEpoch: row.handoffEpoch,
      sessionState: live ? row.sessionState : null,
      requestId: live ? row.requestId : null,
      assigneeFirstName: live ? staffFirstName(row.assigneeDisplayName) : null,
    };
  }

  /**
   * S16 7a: the bot's bulk reconciliation read: the conversations that are in
   * `HUMAN` mode (a STARTING, ACTIVE or ENDING session), each with the shape of
   * the single-conversation state plus `conversationRef`, in `conversationRef`
   * order and paged by keyset (`after` is the last ref of the previous page).
   * `nextCursor` is the last ref of a full page that has more behind it.
   */
  async listHumanConversations(
    limit: number,
    after: string | null,
  ): Promise<{
    items: Array<{
      conversationRef: string;
      mode: 'BOT' | 'HUMAN';
      handoffEpoch: number;
      sessionState: string | null;
      requestId: string | null;
      assigneeFirstName: string | null;
    }>;
    nextLast: string | null;
  }> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    const rows = await tx.$queryRaw<
      {
        conversationRef: string;
        mode: 'BOT' | 'HUMAN';
        handoffEpoch: number;
        sessionState: string | null;
        requestId: string | null;
        assigneeDisplayName: string | null;
      }[]
    >(Prisma.sql`
      SELECT c."conversationRef", c."mode"::text AS "mode", c."handoffEpoch",
             s."state" AS "sessionState", s."requestId", r."assigneeDisplayName"
      FROM "chatbot_conversations" c
      LEFT JOIN LATERAL (
        SELECT s."state", s."requestId" FROM "chatbot_live_sessions" s
        WHERE s."tenantId" = c."tenantId" AND s."conversationId" = c."id"
          AND s."state" <> 'ENDED'
        ORDER BY s."epoch" DESC LIMIT 1) s ON TRUE
      LEFT JOIN "chatbot_requests" r
        ON r."tenantId" = c."tenantId" AND r."id" = s."requestId"
      WHERE c."tenantId" = ${tenantId} AND c."mode" = 'HUMAN'
        ${after === null ? Prisma.empty : Prisma.sql`AND c."conversationRef" > ${after}`}
      ORDER BY c."conversationRef" LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const live = row.sessionState !== null;
        return {
          conversationRef: row.conversationRef,
          mode: row.mode,
          handoffEpoch: row.handoffEpoch,
          sessionState: live ? row.sessionState : null,
          requestId: live ? row.requestId : null,
          assigneeFirstName: live
            ? staffFirstName(row.assigneeDisplayName)
            : null,
        };
      }),
      nextLast:
        rows.length > limit ? page[page.length - 1].conversationRef : null,
    };
  }

  /**
   * §4.4 "Personal → cliente": ONE transaction. Order of checks: request open
   * and the caller its assignee; replay of the same `clientMessageId`;
   * session ACTIVE; `expectedEpoch` current; 24 h window open. A message that
   * fails any of them is never enqueued.
   */
  async sendStaffMessage(input: {
    requestId: string;
    actorUserId: string;
    clientMessageId: string;
    expectedEpoch: number;
    content: StaffMessageContent;
  }): Promise<StaffMessageResult> {
    const { content } = input;
    // What the stored `text` column holds: the text, or the caption.
    const storedText =
      content.type === 'TEXT' ? content.text : (content.caption ?? null);
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      const request = await lockRequestRow(tx, tenantId, input.requestId);
      if (!request) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      const current = {
        version: request.version,
        status: request.status,
        claimedBy:
          request.assigneeUserId && request.assigneeDisplayName
            ? {
                id: request.assigneeUserId,
                displayName: request.assigneeDisplayName,
              }
            : null,
      };
      if (request.kind !== 'CONVERSATION') {
        throw new ChatbotRequestCommandError(
          'ACTION_NOT_ALLOWED',
          422,
          current,
        );
      }
      if (request.assigneeUserId !== input.actorUserId) {
        throw new ChatbotRequestCommandError('NOT_ASSIGNEE', 403);
      }
      const [user] = await tx.$queryRaw<{ name: string; email: string }[]>(
        Prisma.sql`SELECT "name", "email" FROM "users" WHERE "id" = ${input.actorUserId}`,
      );
      const staff = {
        id: input.actorUserId,
        displayName: actorDisplayName(user ?? { name: '', email: '' }),
      };

      const [existing] = await tx.$queryRaw<
        {
          id: string;
          seq: number;
          type: string;
          mediaId: string | null;
          text: string | null;
          staffUserId: string | null;
          deliveryStatus: string | null;
          receivedAt: Date;
          requestMatches: boolean;
        }[]
      >(Prisma.sql`
        SELECT m."id", m."seq", m."type"::text AS "type", m."mediaId", m."text",
               m."staffUserId",
               m."deliveryStatus"::text AS "deliveryStatus", m."receivedAt",
               (c."conversationRef" = ${request.conversationRef}) AS "requestMatches"
        FROM "conversation_messages" m
        JOIN "chatbot_conversations" c
          ON c."tenantId" = m."tenantId" AND c."id" = m."conversationId"
        WHERE m."tenantId" = ${tenantId} AND m."clientMessageId" = ${input.clientMessageId}`);
      if (existing) {
        if (
          !existing.requestMatches ||
          existing.staffUserId !== input.actorUserId ||
          existing.text !== storedText ||
          existing.type !== content.type ||
          existing.mediaId !==
            (content.type === 'TEXT' ? null : content.mediaId)
        ) {
          throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
        }
        const replayMedia = existing.mediaId
          ? await this.mediaOf(tx, tenantId, existing.mediaId)
          : null;
        return this.toResult(
          existing,
          input.clientMessageId,
          staff,
          replayMedia ?? undefined,
        );
      }

      const session = await lockLatestSession(tx, tenantId, request.id);
      if (!session || session.state !== 'ACTIVE') {
        throw new ChatbotRequestCommandError(
          'SESSION_NOT_ACTIVE',
          409,
          current,
          { sessionState: session?.state ?? null },
        );
      }
      if (input.expectedEpoch !== session.epoch) {
        throw new ChatbotRequestCommandError('STALE_EPOCH', 409, current, {
          currentEpoch: session.epoch,
        });
      }
      const conversation = await lockConversation(
        tx,
        tenantId,
        request.conversationRef as string,
      );
      const window = await this.windowOf(
        tx,
        tenantId,
        request.id,
        conversation,
      );
      if (!window.open) {
        const template = await this.templateOffer(
          tx,
          tenantId,
          request.id,
          window,
        );
        throw new ChatbotRequestCommandError('WINDOW_CLOSED', 409, current, {
          templateAllowed: template.allowed,
          whatsappWindowClosesAt: window.closesAt?.toISOString() ?? null,
        });
      }

      // T11c: the media must be this attendee's upload for THIS request. The
      // row is locked FOR SHARE so a concurrent purge cannot slip between this
      // check and the insert.
      let media: StoredMedia | null = null;
      if (content.type !== 'TEXT') {
        media = await this.lockOwnedMedia(
          tx,
          tenantId,
          content.mediaId,
          request.id,
          input.actorUserId,
          content.type,
        );
      }

      const messageId = randomUUID();
      const seq = conversation.nextSeq;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_conversations"
        SET "nextSeq" = ${seq + 1}, "updatedAt" = now()
        WHERE "id" = ${conversation.id}`);
      const [stored] = await tx.$queryRaw<{ receivedAt: Date }[]>(Prisma.sql`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author",
           "staffUserId", "clientMessageId", "type", "text", "mediaId",
           "receivedAt", "deliveryStatus", "purgeAfter")
        VALUES (${messageId}, ${tenantId}, ${conversation.id}, ${seq}, 'OUT',
                'STAFF', ${input.actorUserId}, ${input.clientMessageId},
                ${content.type}::"ConversationMessageType", ${storedText},
                ${media?.id ?? null}, now(), 'QUEUED',
                now() + interval '12 months')
        RETURNING "receivedAt"`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_live_sessions"
        SET "lastStaffActivityAt" = now(), "updatedAt" = now()
        WHERE "id" = ${session.id}`);
      await insertFeedItems(tx, tenantId, [
        {
          requestId: request.id,
          type: FEED_TYPE.staffMessage,
          conversationRef: request.conversationRef,
          payload: buildStaffMessagePayload({
            requestId: request.id,
            handoffEpoch: session.epoch,
            seq,
            messageId,
            ...(media && content.type !== 'TEXT'
              ? {
                  media: {
                    type: content.type,
                    mediaId: media.id,
                    mimeType: media.mimeType,
                    filename: media.filename,
                    caption: content.caption,
                  },
                }
              : { text: storedText ?? '' }),
          }),
        },
      ]);
      await emitRealtimeEvents(tx, [
        {
          tenantId,
          userId: null,
          type: 'conversation.message',
          requestId: request.id,
          payload: { messageId, seq },
        },
      ]);
      return this.toResult(
        {
          id: messageId,
          seq,
          type: content.type,
          text: storedText,
          deliveryStatus: 'QUEUED',
          receivedAt: stored.receivedAt,
        },
        input.clientMessageId,
        staff,
        media ?? undefined,
      );
    });
  }

  /**
   * §4.5: the chat's 24 h window as the staff checks see it. `key` is the
   * instant the window closed (it identifies "this closed window" for the
   * once-per-window template); with no customer message known at all it is
   * the request's creation time, which no later window can share.
   */
  private async windowOf(
    tx: TenantClient,
    tenantId: string,
    requestId: string,
    conversation: {
      lastCustomerMessageAt: Date | null;
      windowClosedAt: Date | null;
    },
  ): Promise<{
    open: boolean;
    closesAt: Date | null;
    key: Date;
    lastCustomerAt: Date | null;
  }> {
    const [row] = await tx.$queryRaw<
      { lastCustomerMessageAt: Date | null; createdAt: Date }[]
    >(Prisma.sql`
      SELECT "lastCustomerMessageAt", "createdAt" FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}`);
    const closesAt = whatsappWindowClosesAt(
      conversation.lastCustomerMessageAt,
      row?.lastCustomerMessageAt ?? null,
      conversation.windowClosedAt,
    );
    const lastCustomerAt =
      [conversation.lastCustomerMessageAt, row?.lastCustomerMessageAt ?? null]
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      open: closesAt !== null && closesAt.getTime() > Date.now(),
      closesAt,
      key: closesAt ?? row?.createdAt,
      lastCustomerAt,
    };
  }

  /**
   * Can a template be requested now? It needs the tenant's approved template
   * name and no live template since the customer last wrote: ANY `TEMPLATE`
   * message of this request newer than the last customer message (chat or
   * request row) whose status is not `FAILED` refuses it (QUEUED, SENT,
   * DELIVERED, READ and UNKNOWN: it may have been sent, and it costs money). A
   * `FAILED` one (Meta refused it, or a later failed status) may be replaced.
   * The rule does NOT match the window key (`windowClosedAt`): that instant
   * moves when a later 131047 raises the chat's `windowClosedAt`, and a second
   * template would pass while the first is UNKNOWN (verify F3). The key only
   * decides which once-per-window row a new template reuses. The rows are
   * locked: a concurrent click waits for this transaction (the request row
   * already serializes clicks).
   */
  private async templateOffer(
    tx: TenantClient,
    tenantId: string,
    requestId: string,
    window: { key: Date; lastCustomerAt: Date | null },
  ): Promise<{
    allowed: boolean;
    name: string | null;
    languageCode: string;
    existingId: string | null;
    taken: boolean;
  }> {
    const settings = await readSettingsRow(tx, tenantId);
    const rows = await tx.$queryRaw<
      {
        id: string;
        sameWindow: boolean;
        deliveryStatus: string | null;
        since: boolean;
      }[]
    >(Prisma.sql`
      SELECT t."id", (t."windowClosedAt" = ${window.key}) AS "sameWindow",
             m."deliveryStatus"::text AS "deliveryStatus",
             (${window.lastCustomerAt}::timestamptz IS NULL
              OR m."receivedAt" > ${window.lastCustomerAt}) AS "since"
      FROM "chatbot_session_templates" t
      LEFT JOIN "conversation_messages" m
        ON m."tenantId" = t."tenantId" AND m."id" = t."messageId"
      WHERE t."tenantId" = ${tenantId} AND t."requestId" = ${requestId}
      ORDER BY t."id"
      FOR UPDATE OF t`);
    const taken = rows.some(
      (r) =>
        r.since && r.deliveryStatus !== null && r.deliveryStatus !== 'FAILED',
    );
    const existing = rows.find((r) => r.sameWindow);
    return {
      allowed: !!settings?.templateName && !taken,
      name: settings?.templateName ?? null,
      languageCode: settings?.templateLanguageCode ?? 'es_MX',
      existingId: existing?.id ?? null,
      taken,
    };
  }

  /**
   * §4.5 / S16 8: the attendee's "Enviar plantilla" button. ONE transaction,
   * the same gates as a message (request, assignee, replay of the key, session
   * ACTIVE, epoch) and then the inverse window check: it is refused while the
   * window is open (`409 WINDOW_OPEN`), without a configured template name
   * (`422 TEMPLATE_NOT_CONFIGURED`) and when this closed window already has a
   * live template (`409 TEMPLATE_ALREADY_SENT`). It stores a `TEMPLATE` message
   * (`text` = the template name), enqueues `template.requested`, records the
   * once-per-window row (replacing the message of a failed one) and a
   * `TEMPLATE_SENT` audit event. Nothing automatic ever calls it.
   */
  async requestTemplate(input: {
    requestId: string;
    actorUserId: string;
    clientMessageId: string;
    expectedEpoch: number;
  }): Promise<StaffMessageResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      const request = await lockRequestRow(tx, tenantId, input.requestId);
      if (!request) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
      const current = {
        version: request.version,
        status: request.status,
        claimedBy:
          request.assigneeUserId && request.assigneeDisplayName
            ? {
                id: request.assigneeUserId,
                displayName: request.assigneeDisplayName,
              }
            : null,
      };
      if (request.kind !== 'CONVERSATION') {
        throw new ChatbotRequestCommandError(
          'ACTION_NOT_ALLOWED',
          422,
          current,
        );
      }
      if (request.assigneeUserId !== input.actorUserId) {
        throw new ChatbotRequestCommandError('NOT_ASSIGNEE', 403);
      }
      const [user] = await tx.$queryRaw<{ name: string; email: string }[]>(
        Prisma.sql`SELECT "name", "email" FROM "users" WHERE "id" = ${input.actorUserId}`,
      );
      const staff = {
        id: input.actorUserId,
        displayName: actorDisplayName(user ?? { name: '', email: '' }),
      };

      const [existing] = await tx.$queryRaw<
        {
          id: string;
          seq: number;
          type: string;
          text: string | null;
          staffUserId: string | null;
          deliveryStatus: string | null;
          receivedAt: Date;
          requestMatches: boolean;
        }[]
      >(Prisma.sql`
        SELECT m."id", m."seq", m."type"::text AS "type", m."text",
               m."staffUserId", m."deliveryStatus"::text AS "deliveryStatus",
               m."receivedAt",
               (c."conversationRef" = ${request.conversationRef}) AS "requestMatches"
        FROM "conversation_messages" m
        JOIN "chatbot_conversations" c
          ON c."tenantId" = m."tenantId" AND c."id" = m."conversationId"
        WHERE m."tenantId" = ${tenantId} AND m."clientMessageId" = ${input.clientMessageId}`);
      if (existing) {
        if (
          !existing.requestMatches ||
          existing.staffUserId !== input.actorUserId ||
          existing.type !== 'TEMPLATE'
        ) {
          throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
        }
        return this.toResult(existing, input.clientMessageId, staff);
      }

      const session = await lockLatestSession(tx, tenantId, request.id);
      if (!session || session.state !== 'ACTIVE') {
        throw new ChatbotRequestCommandError(
          'SESSION_NOT_ACTIVE',
          409,
          current,
          { sessionState: session?.state ?? null },
        );
      }
      if (input.expectedEpoch !== session.epoch) {
        throw new ChatbotRequestCommandError('STALE_EPOCH', 409, current, {
          currentEpoch: session.epoch,
        });
      }
      const conversation = await lockConversation(
        tx,
        tenantId,
        request.conversationRef as string,
      );
      const window = await this.windowOf(
        tx,
        tenantId,
        request.id,
        conversation,
      );
      if (window.open) {
        throw new ChatbotRequestCommandError('WINDOW_OPEN', 409, current, {
          whatsappWindowClosesAt: window.closesAt?.toISOString() ?? null,
        });
      }
      const offer = await this.templateOffer(tx, tenantId, request.id, window);
      if (!offer.name) {
        throw new ChatbotRequestCommandError('TEMPLATE_NOT_CONFIGURED', 422);
      }
      if (offer.taken) {
        throw new ChatbotRequestCommandError(
          'TEMPLATE_ALREADY_SENT',
          409,
          current,
        );
      }

      const messageId = randomUUID();
      const seq = conversation.nextSeq;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_conversations"
        SET "nextSeq" = ${seq + 1}, "updatedAt" = now()
        WHERE "id" = ${conversation.id}`);
      const [stored] = await tx.$queryRaw<{ receivedAt: Date }[]>(Prisma.sql`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author",
           "staffUserId", "clientMessageId", "type", "text", "receivedAt",
           "deliveryStatus", "purgeAfter")
        VALUES (${messageId}, ${tenantId}, ${conversation.id}, ${seq}, 'OUT',
                'STAFF', ${input.actorUserId}, ${input.clientMessageId},
                'TEMPLATE'::"ConversationMessageType", ${offer.name}, now(),
                'QUEUED', now() + interval '12 months')
        RETURNING "receivedAt"`);
      if (offer.existingId) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chatbot_session_templates"
          SET "messageId" = ${messageId}, "sessionId" = ${session.id}
          WHERE "tenantId" = ${tenantId} AND "id" = ${offer.existingId}`);
      } else {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "chatbot_session_templates"
            ("id", "tenantId", "requestId", "sessionId", "windowClosedAt",
             "messageId")
          VALUES (${randomUUID()}, ${tenantId}, ${request.id}, ${session.id},
                  ${window.key}, ${messageId})`);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_live_sessions"
        SET "lastStaffActivityAt" = now(), "updatedAt" = now()
        WHERE "id" = ${session.id}`);
      await insertFeedItems(tx, tenantId, [
        {
          requestId: request.id,
          type: FEED_TYPE.templateRequested,
          conversationRef: request.conversationRef,
          payload: buildTemplateRequestedPayload({
            requestId: request.id,
            handoffEpoch: session.epoch,
            seq,
            messageId,
            templateName: offer.name,
            languageCode: offer.languageCode,
          }),
        },
      ]);
      await tx.chatbotRequestEvent.create({
        data: {
          tenantId,
          requestId: request.id,
          type: 'TEMPLATE_SENT',
          actorKind: 'USER',
          actorId: input.actorUserId,
          actorDisplayName: staff.displayName,
          version: request.version,
          data: {
            messageId,
            templateName: offer.name,
            languageCode: offer.languageCode,
            handoffEpoch: session.epoch,
          },
        },
      });
      await emitRealtimeEvents(tx, [
        {
          tenantId,
          userId: null,
          type: 'conversation.message',
          requestId: request.id,
          payload: { messageId, seq },
        },
      ]);
      return this.toResult(
        {
          id: messageId,
          seq,
          type: 'TEMPLATE',
          text: offer.name,
          deliveryStatus: 'QUEUED',
          receivedAt: stored.receivedAt,
        },
        input.clientMessageId,
        staff,
      );
    });
  }

  /**
   * T11c: may this user upload a file for this request right now? The request
   * is a conversation of this tenant (404), the caller is its assignee (403)
   * and its latest session is ACTIVE (409), the same gates as a text message.
   */
  async assertCanUpload(requestId: string, actorUserId: string): Promise<void> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    const [request] = await tx.$queryRaw<
      {
        kind: string;
        assigneeUserId: string | null;
      }[]
    >(Prisma.sql`
      SELECT "kind"::text AS "kind", "assigneeUserId" FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}`);
    if (!request) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    if (request.kind !== 'CONVERSATION') {
      throw new ChatbotRequestCommandError('ACTION_NOT_ALLOWED', 422);
    }
    if (request.assigneeUserId !== actorUserId) {
      throw new ChatbotRequestCommandError('NOT_ASSIGNEE', 403);
    }
    const [session] = await tx.$queryRaw<{ state: string }[]>(Prisma.sql`
      SELECT "state" FROM "chatbot_live_sessions"
      WHERE "tenantId" = ${tenantId} AND "requestId" = ${requestId}
      ORDER BY "epoch" DESC LIMIT 1`);
    if (!session || session.state !== 'ACTIVE') {
      throw new ChatbotRequestCommandError(
        'SESSION_NOT_ACTIVE',
        409,
        undefined,
        {
          sessionState: session?.state ?? null,
        },
      );
    }
  }

  private async mediaOf(
    tx: TenantClient,
    tenantId: string,
    mediaId: string,
  ): Promise<StoredMedia | null> {
    const [row] = await tx.$queryRaw<StoredMedia[]>(Prisma.sql`
      SELECT "id", "mimeType", "filename" FROM "conversation_media"
      WHERE "tenantId" = ${tenantId} AND "id" = ${mediaId}`);
    return row ?? null;
  }

  private async lockOwnedMedia(
    tx: TenantClient,
    tenantId: string,
    mediaId: string,
    requestId: string,
    actorUserId: string,
    messageType: 'IMAGE' | 'DOCUMENT',
  ): Promise<StoredMedia> {
    const [row] = await tx.$queryRaw<
      (StoredMedia & {
        requestId: string | null;
        uploadedByUserId: string | null;
        purgedAt: Date | null;
      })[]
    >(Prisma.sql`
      SELECT "id", "mimeType", "filename", "requestId", "uploadedByUserId",
             "purgedAt"
      FROM "conversation_media"
      WHERE "tenantId" = ${tenantId} AND "id" = ${mediaId}
      FOR SHARE`);
    if (
      !row ||
      row.requestId !== requestId ||
      row.uploadedByUserId !== actorUserId
    ) {
      throw new ChatbotRequestCommandError('MEDIA_NOT_FOUND', 404);
    }
    if (row.purgedAt) {
      throw new ChatbotRequestCommandError('MEDIA_PURGED', 422);
    }
    if (!mediaMatchesMessageType(messageType, row.mimeType)) {
      throw new ChatbotRequestCommandError('MEDIA_TYPE_MISMATCH', 422);
    }
    return { id: row.id, mimeType: row.mimeType, filename: row.filename };
  }

  private toResult(
    row: {
      id: string;
      seq: number;
      type?: string;
      text: string | null;
      deliveryStatus: string | null;
      receivedAt: Date;
    },
    clientMessageId: string,
    staff: { id: string; displayName: string },
    media?: StoredMedia,
  ): StaffMessageResult {
    return {
      message: {
        id: row.id,
        seq: row.seq,
        direction: 'OUT',
        author: 'STAFF',
        type: (row.type ?? 'TEXT') as StaffMessageResult['message']['type'],
        text: row.type === 'TEMPLATE' ? '' : (row.text ?? ''),
        ...(row.type === 'TEMPLATE' && row.text
          ? { templateName: row.text }
          : {}),
        ...(media
          ? {
              media: {
                id: media.id,
                mimeType: media.mimeType,
                filename: media.filename,
              },
            }
          : {}),
        deliveryStatus: row.deliveryStatus ?? 'QUEUED',
        clientMessageId,
        staff,
        createdAt: row.receivedAt.toISOString(),
      },
    };
  }
}
