/**
 * Writes of the live conversation session (human-intervention unit 11;
 * contract §4.2 to §4.8, §12.15). Every helper runs on the caller's
 * transaction client and assumes the caller already holds the REQUEST row lock
 * (§6.5: request first, then the conversation row, then the feed lock, the
 * customer group, and the realtime lock LAST).
 *
 * `session.*` realtime events are written by `emitSessionEvent`, which the
 * caller invokes after everything else: the realtime tenant lock must be the
 * last lock of the transaction (unit 8 rules).
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { emitRealtimeEvents } from '../../shared/realtime/realtime-event-writes';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import {
  buildConversationEndedPayload,
  buildConversationStartedPayload,
  FEED_TYPE,
} from '../domain/chatbot-feed';
import {
  staffFirstName,
  whatsappWindowClosesAt,
  type SessionEndReason,
  type SessionState,
} from '../domain/live-session';
import { insertFeedItems } from './chatbot-feed-writes';
import type { TenantClient } from './chatbot-request-writes';

export type SessionEventType =
  | 'session.starting'
  | 'session.active'
  | 'session.ending'
  | 'session.ended';

export interface LiveSessionRow {
  id: string;
  requestId: string;
  conversationId: string;
  epoch: number;
  state: SessionState;
  endReason: SessionEndReason | null;
  staffUserId: string;
  startSeq: number;
  startedAt: Date;
  activeAt: Date | null;
  endingAt: Date | null;
}

const SESSION_COLUMNS = Prisma.sql`s."id", s."requestId", s."conversationId", s."epoch",
  s."state", s."endReason", s."staffUserId", s."startSeq", s."startedAt",
  s."activeAt", s."endingAt"`;

/** The newest session of a request (highest epoch), locked. */
export async function lockLatestSession(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
): Promise<LiveSessionRow | null> {
  const rows = await tx.$queryRaw<LiveSessionRow[]>(Prisma.sql`
    SELECT ${SESSION_COLUMNS} FROM "chatbot_live_sessions" s
    WHERE s."tenantId" = ${tenantId} AND s."requestId" = ${requestId}
    ORDER BY s."epoch" DESC LIMIT 1 FOR UPDATE`);
  return rows[0] ?? null;
}

/** `version + 1` for a session transition that is not a command (§12.8). */
export async function bumpVersion(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
): Promise<number> {
  const [row] = await tx.$queryRaw<{ version: number }[]>(Prisma.sql`
    UPDATE "chatbot_requests" SET "version" = "version" + 1, "updatedAt" = now()
    WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}
    RETURNING "version"`);
  return row.version;
}

export interface ConversationRow {
  id: string;
  mode: 'BOT' | 'HUMAN';
  handoffEpoch: number;
  nextSeq: number;
  lastCustomerMessageAt: Date | null;
}

/** Upserts and locks the chat row (the mirror's own statement shape). */
export async function lockConversation(
  tx: TenantClient,
  tenantId: string,
  conversationRef: string,
): Promise<ConversationRow> {
  const [row] = await tx.$queryRaw<ConversationRow[]>(Prisma.sql`
    INSERT INTO "chatbot_conversations"
      ("id", "tenantId", "conversationRef", "updatedAt")
    VALUES (${randomUUID()}, ${tenantId}, ${conversationRef}, now())
    ON CONFLICT ("tenantId", "conversationRef") DO UPDATE SET "updatedAt" = now()
    RETURNING "id", "mode"::text AS "mode", "handoffEpoch", "nextSeq",
              "lastCustomerMessageAt"`);
  return row;
}

/**
 * The claim of a live request (§4.3): epoch + 1, `mode = HUMAN`, a STARTING
 * session and `conversation.started` for the bot, all in the claim's
 * transaction. One live session per chat (the partial unique index): a second
 * claim on another request of the same conversation is refused.
 */
export async function startLiveSession(
  tx: TenantClient,
  tenantId: string,
  request: {
    id: string;
    conversationRef: string;
    version: number;
    requestLastCustomerMessageAt: Date | null;
  },
  staff: { userId: string; displayName: string },
): Promise<{ epoch: number }> {
  const conversation = await lockConversation(
    tx,
    tenantId,
    request.conversationRef,
  );
  const [live] = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
    SELECT 1 AS "one" FROM "chatbot_live_sessions"
    WHERE "tenantId" = ${tenantId} AND "conversationId" = ${conversation.id}
      AND "state" <> 'ENDED' LIMIT 1`);
  if (live) {
    throw new ChatbotRequestCommandError('ACTION_NOT_ALLOWED', 422, {
      version: request.version,
      status: 'IN_PROGRESS',
      claimedBy: null,
    });
  }
  const epoch = conversation.handoffEpoch + 1;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_conversations"
    SET "mode" = 'HUMAN', "handoffEpoch" = ${epoch}, "updatedAt" = now()
    WHERE "id" = ${conversation.id}`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "chatbot_live_sessions"
      ("id", "tenantId", "requestId", "conversationId", "epoch", "state",
       "staffUserId", "startSeq", "updatedAt")
    VALUES (${randomUUID()}, ${tenantId}, ${request.id}, ${conversation.id},
            ${epoch}, 'STARTING', ${staff.userId}, ${conversation.nextSeq}, now())`);
  await insertFeedItems(tx, tenantId, [
    {
      requestId: request.id,
      type: FEED_TYPE.conversationStarted,
      conversationRef: request.conversationRef,
      payload: buildConversationStartedPayload({
        requestId: request.id,
        handoffEpoch: epoch,
        staffFirstName: staffFirstName(staff.displayName),
        whatsappWindowClosesAt: whatsappWindowClosesAt(
          conversation.lastCustomerMessageAt,
          request.requestLastCustomerMessageAt,
        ),
      }),
    },
  ]);
  return { epoch };
}

/** ACTIVE -> ENDING (finish, forced finish or idle end) and `conversation.ended`. */
export async function beginSessionEnding(
  tx: TenantClient,
  tenantId: string,
  session: Pick<LiveSessionRow, 'id' | 'requestId' | 'epoch'>,
  conversationRef: string,
  reason: Extract<SessionEndReason, 'FINISHED' | 'FORCED' | 'IDLE_TIMEOUT'>,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_live_sessions"
    SET "state" = 'ENDING', "endReason" = ${reason}, "endingAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${session.id}`);
  await insertFeedItems(tx, tenantId, [
    {
      requestId: session.requestId,
      type: FEED_TYPE.conversationEnded,
      conversationRef,
      payload: buildConversationEndedPayload({
        requestId: session.requestId,
        handoffEpoch: session.epoch,
        reason,
      }),
    },
  ]);
}

/**
 * STARTING -> ENDED (the 60 s revert, §12.15): the conversation goes back to
 * BOT in the SAME epoch and the bot hears `conversation.ended START_TIMEOUT`.
 */
export async function revertStart(
  tx: TenantClient,
  tenantId: string,
  session: Pick<
    LiveSessionRow,
    'id' | 'requestId' | 'epoch' | 'conversationId'
  >,
  conversationRef: string,
): Promise<void> {
  await markEnded(tx, session, 'START_TIMEOUT');
  await insertFeedItems(tx, tenantId, [
    {
      requestId: session.requestId,
      type: FEED_TYPE.conversationEnded,
      conversationRef,
      payload: buildConversationEndedPayload({
        requestId: session.requestId,
        handoffEpoch: session.epoch,
        reason: 'START_TIMEOUT',
      }),
    },
  ]);
}

/** -> ENDED; the chat is back to BOT. */
export async function markEnded(
  tx: TenantClient,
  session: Pick<LiveSessionRow, 'id' | 'conversationId'>,
  reason?: SessionEndReason,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_live_sessions"
    SET "state" = 'ENDED', "endedAt" = now(), "updatedAt" = now(),
        "endReason" = COALESCE(${reason ?? null}, "endReason")
    WHERE "id" = ${session.id}`);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_conversations" SET "mode" = 'BOT', "updatedAt" = now()
    WHERE "id" = ${session.conversationId}`);
}

/** ACTIVE: the bot confirmed it is muted (§4.3). */
export async function markActive(
  tx: TenantClient,
  sessionId: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_live_sessions"
    SET "state" = 'ACTIVE', "activeAt" = now(), "lastStaffActivityAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${sessionId}`);
}

/** The LAST write of the transaction: one `session.*` event with the row. */
export function emitSessionEvent(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  type: SessionEventType,
  version: number,
): Promise<void> {
  return emitRealtimeEvents(tx, [
    { tenantId, userId: null, type, requestId, payload: { version } },
  ]);
}

/**
 * §4.4/§4.5/§4.7: what the bot's delivery outcome means for the staff message
 * (or template) the item carried. The status only moves forward (the trigger
 * enforces it; the guard below avoids raising), the wamid is stored ONCE from
 * `providerMessageId` so later `statuses:batch` find the message, and
 * `DEFERRED_WINDOW_CLOSED` also corrects the chat's window (Meta wins): the
 * window is treated as closed from `attemptedAt` until the customer's next
 * message. Returns the message's `seq` and new status for the realtime event.
 */
export async function applyStaffMessageOutcome(
  tx: TenantClient,
  tenantId: string,
  input: {
    messageId: string;
    status: 'SENT' | 'UNKNOWN' | 'DEFERRED' | 'FAILED';
    providerMessageId: string | null;
    attemptedAt: Date | null;
  },
): Promise<{ seq: number; deliveryStatus: string } | null> {
  const [message] = await tx.$queryRaw<
    {
      seq: number;
      conversationId: string;
      waMessageId: string | null;
      deliveryStatus: string | null;
    }[]
  >(Prisma.sql`
    SELECT "seq", "conversationId", "waMessageId", "deliveryStatus"::text AS "deliveryStatus"
    FROM "conversation_messages"
    WHERE "tenantId" = ${tenantId} AND "id" = ${input.messageId}
    FOR UPDATE`);
  if (!message) return null;
  const advance = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
    SELECT "conversation_delivery_can_advance"(${message.deliveryStatus}, ${input.status}) AS "ok"`);
  let status = message.deliveryStatus ?? input.status;
  if (advance[0]?.ok) {
    let wamid: string | null = null;
    if (input.providerMessageId && message.waMessageId === null) {
      const [taken] = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
        SELECT 1 AS "one" FROM "conversation_messages"
        WHERE "tenantId" = ${tenantId} AND "waMessageId" = ${input.providerMessageId}
        LIMIT 1`);
      wamid = taken ? null : input.providerMessageId;
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "conversation_messages"
      SET "deliveryStatus" = ${input.status}::"ConversationDeliveryStatus",
          "waMessageId" = COALESCE("waMessageId", ${wamid})
      WHERE "tenantId" = ${tenantId} AND "id" = ${input.messageId}`);
    status = input.status;
  }
  if (input.status === 'DEFERRED' && input.attemptedAt) {
    // The window closed no later than `attemptedAt`: the newest customer
    // message is then at most 24 h before it.
    const cap = new Date(input.attemptedAt.getTime() - 24 * 3_600_000);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_conversations"
      SET "lastCustomerMessageAt" = ${cap}, "updatedAt" = now()
      WHERE "tenantId" = ${tenantId} AND "id" = ${message.conversationId}
        AND "lastCustomerMessageAt" > ${cap}`);
  }
  return { seq: message.seq, deliveryStatus: status };
}
