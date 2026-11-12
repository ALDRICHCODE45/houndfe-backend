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
import { buildStaffMessagePayload, FEED_TYPE } from '../domain/chatbot-feed';
import {
  decideSessionAck,
  staffFirstName,
  whatsappWindowClosesAt,
} from '../domain/live-session';
import { insertFeedItems } from './chatbot-feed-writes';
import { lockRequestRow } from './chatbot-request-writes';
import {
  bumpVersion,
  emitSessionEvent,
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
    type: 'TEXT';
    text: string;
    deliveryStatus: string;
    clientMessageId: string;
    staff: { id: string; displayName: string };
    createdAt: string;
  };
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
      const version = await bumpVersion(tx, tenantId, latest.requestId);
      await emitSessionEvent(
        tx,
        tenantId,
        latest.requestId,
        'session.ended',
        version,
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
    text: string;
    templateAllowed: boolean;
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
          text: string | null;
          staffUserId: string | null;
          deliveryStatus: string | null;
          receivedAt: Date;
          requestMatches: boolean;
        }[]
      >(Prisma.sql`
        SELECT m."id", m."seq", m."text", m."staffUserId",
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
          existing.text !== input.text
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
      const [window] = await tx.$queryRaw<
        { lastCustomerMessageAt: Date | null }[]
      >(Prisma.sql`
        SELECT "lastCustomerMessageAt" FROM "chatbot_requests"
        WHERE "tenantId" = ${tenantId} AND "id" = ${request.id}`);
      const closesAt = whatsappWindowClosesAt(
        conversation.lastCustomerMessageAt,
        window?.lastCustomerMessageAt ?? null,
        conversation.windowClosedAt,
      );
      if (!closesAt || closesAt.getTime() <= Date.now()) {
        throw new ChatbotRequestCommandError('WINDOW_CLOSED', 409, current, {
          templateAllowed: input.templateAllowed,
          whatsappWindowClosesAt: closesAt?.toISOString() ?? null,
        });
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
                'STAFF', ${input.actorUserId}, ${input.clientMessageId}, 'TEXT',
                ${input.text}, now(), 'QUEUED', now() + interval '12 months')
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
            text: input.text,
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
          text: input.text,
          deliveryStatus: 'QUEUED',
          receivedAt: stored.receivedAt,
        },
        input.clientMessageId,
        staff,
      );
    });
  }

  private toResult(
    row: {
      id: string;
      seq: number;
      text: string | null;
      deliveryStatus: string | null;
      receivedAt: Date;
    },
    clientMessageId: string,
    staff: { id: string; displayName: string },
  ): StaffMessageResult {
    return {
      message: {
        id: row.id,
        seq: row.seq,
        direction: 'OUT',
        author: 'STAFF',
        type: 'TEXT',
        text: row.text ?? '',
        deliveryStatus: row.deliveryStatus ?? 'QUEUED',
        clientMessageId,
        staff,
        createdAt: row.receivedAt.toISOString(),
      },
    };
  }
}
