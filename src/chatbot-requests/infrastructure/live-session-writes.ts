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
  buildConversationReassignedPayload,
  buildConversationStartedPayload,
  FEED_TYPE,
} from '../domain/chatbot-feed';
import {
  SESSION_TIMING,
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
  windowClosedAt: Date | null;
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
              "lastCustomerMessageAt", "windowClosedAt"`);
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
  // S16 1a: the tenant's start timeout (default 120 s) is snapshotted on the
  // session, so a later settings change never moves this deadline.
  const [settings] = await tx.$queryRaw<{ startTimeoutSeconds: number }[]>(
    Prisma.sql`
    SELECT "startTimeoutSeconds" FROM "chatbot_attention_settings"
    WHERE "tenantId" = ${tenantId}`,
  );
  const startTimeoutSeconds =
    settings?.startTimeoutSeconds ?? SESSION_TIMING.startTimeoutMs / 1000;
  const epoch = conversation.handoffEpoch + 1;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_conversations"
    SET "mode" = 'HUMAN', "handoffEpoch" = ${epoch}, "updatedAt" = now()
    WHERE "id" = ${conversation.id}`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "chatbot_live_sessions"
      ("id", "tenantId", "requestId", "conversationId", "epoch", "state",
       "staffUserId", "startSeq", "startedAt", "startDeadlineAt", "updatedAt")
    VALUES (${randomUUID()}, ${tenantId}, ${request.id}, ${conversation.id},
            ${epoch}, 'STARTING', ${staff.userId}, ${conversation.nextSeq},
            now(), now() + make_interval(secs => ${startTimeoutSeconds}), now())`);
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
          conversation.windowClosedAt,
        ),
      }),
    },
  ]);
  return { epoch };
}

/**
 * S15 Q2 / S16 10: a STARTING or ACTIVE session handed to another attendee
 * keeps its epoch; the session's staff user moves and the bot hears
 * `conversation.reassigned {handoffEpoch, staffFirstName}` so it can tell the
 * customer "Ahora te atiende <nombre>". Any other state is a no-op. Realtime:
 * the staff already get `request.reassigned` from the audit event and the
 * session STATE does not change, so no `session.*` event goes out.
 */
export async function reassignLiveSession(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  conversationRef: string,
  toUser: { userId: string; displayName: string },
): Promise<void> {
  const session = await lockLatestSession(tx, tenantId, requestId);
  if (!session || (session.state !== 'STARTING' && session.state !== 'ACTIVE'))
    return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_live_sessions"
    SET "staffUserId" = ${toUser.userId}, "lastStaffActivityAt" = now(),
        "updatedAt" = now()
    WHERE "id" = ${session.id}`);
  await insertFeedItems(tx, tenantId, [
    {
      requestId,
      type: FEED_TYPE.conversationReassigned,
      conversationRef,
      payload: buildConversationReassignedPayload({
        requestId,
        handoffEpoch: session.epoch,
        staffFirstName: staffFirstName(toUser.displayName),
      }),
    },
  ]);
}

/** A staff message that became terminal FAILED (for `message.status`). */
export interface FailedMessage {
  messageId: string;
  seq: number;
}

/**
 * S16 3: the staff messages of this request still DEFERRED by a closed window
 * (feed outcome `DEFERRED_WINDOW_CLOSED`, not acknowledged) with
 * `handoffEpoch <= upToEpoch` become terminal: the message is `FAILED` and the
 * feed item is acknowledged (outcome `STALE`: the CHECK allows an ack only with a terminal outcome; it leaves `pending-deliveries`; a resend is a 409
 * `OUTCOME_ALREADY_RECORDED`). The item rows are taken `SKIP LOCKED`: a bot
 * ACK in flight holds its item and waits for the request row this transaction
 * holds, so waiting for it would be a cycle; if that ACK is a resend it is
 * still valid, and if it is another deferral `failDeferredAfterSession`
 * settles it. The caller emits `message.status` (the realtime lock is last).
 */
export async function failDeferredStaffMessages(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  upToEpoch: number,
): Promise<FailedMessage[]> {
  const due = await tx.$queryRaw<{ cursor: bigint; messageId: string }[]>(
    Prisma.sql`
    SELECT f."cursor", f."payload"->>'messageId' AS "messageId"
    FROM "chatbot_feed_items" f
    WHERE f."tenantId" = ${tenantId} AND f."requestId" = ${requestId}
      AND f."type" = ${FEED_TYPE.staffMessage}
      AND f."outcome" = 'DEFERRED_WINDOW_CLOSED' AND f."ackedAt" IS NULL
      AND (f."payload"->>'handoffEpoch')::int <= ${upToEpoch}
    ORDER BY f."cursor"
    FOR UPDATE SKIP LOCKED`,
  );
  const failed: FailedMessage[] = [];
  for (const item of due) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_feed_items" SET "outcome" = 'STALE', "ackedAt" = now()
      WHERE "tenantId" = ${tenantId} AND "cursor" = ${item.cursor}`);
    const applied = await applyStaffMessageOutcome(tx, tenantId, {
      messageId: item.messageId,
      status: 'FAILED',
      providerMessageId: null,
      attemptedAt: null,
    });
    if (applied) failed.push({ messageId: item.messageId, seq: applied.seq });
  }
  return failed;
}

/** ACTIVE -> ENDING (finish, forced finish or idle end) and `conversation.ended`. */
export async function beginSessionEnding(
  tx: TenantClient,
  tenantId: string,
  session: Pick<LiveSessionRow, 'id' | 'requestId' | 'epoch'>,
  conversationRef: string,
  reason: Extract<SessionEndReason, 'FINISHED' | 'FORCED' | 'IDLE_TIMEOUT'>,
): Promise<FailedMessage[]> {
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
  // The window-deferred staff messages of this epoch will never be resent.
  return failDeferredStaffMessages(
    tx,
    tenantId,
    session.requestId,
    session.epoch,
  );
}

/**
 * The bot reported `DEFERRED_WINDOW_CLOSED` for a staff message whose epoch is
 * no longer an ACTIVE session: nobody will resend it, so it is terminal at
 * once (message `FAILED`, item acknowledged). `true` when it was settled.
 */
export async function failDeferredAfterSession(
  tx: TenantClient,
  tenantId: string,
  input: {
    requestId: string;
    cursor: bigint;
    messageId: string;
    epoch: number;
  },
): Promise<FailedMessage | null> {
  const [active] = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
    SELECT 1 AS "one" FROM "chatbot_live_sessions"
    WHERE "tenantId" = ${tenantId} AND "requestId" = ${input.requestId}
      AND "epoch" = ${input.epoch} AND "state" = 'ACTIVE'`);
  if (active) return null;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_feed_items" SET "outcome" = 'STALE', "ackedAt" = now()
    WHERE "tenantId" = ${tenantId} AND "cursor" = ${input.cursor}`);
  const applied = await applyStaffMessageOutcome(tx, tenantId, {
    messageId: input.messageId,
    status: 'FAILED',
    providerMessageId: null,
    attemptedAt: null,
  });
  return applied ? { messageId: input.messageId, seq: applied.seq } : null;
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

/** `message.status` FAILED events for the messages a settle turned terminal. */
function failedStatusEvents(
  tenantId: string,
  requestId: string,
  failedMessages: FailedMessage[],
) {
  // S16 3: the attendee sees the deferred messages turn "No enviado".
  return failedMessages.map(({ messageId, seq }) => ({
    tenantId,
    userId: null,
    type: 'message.status',
    requestId,
    payload: { messageId, seq, deliveryStatus: 'FAILED' },
  }));
}

/** The LAST write of the transaction: one `session.*` event with the row. */
export function emitSessionEvent(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  type: SessionEventType,
  version: number,
  failedMessages: FailedMessage[] = [],
): Promise<void> {
  return emitRealtimeEvents(tx, [
    { tenantId, userId: null, type, requestId, payload: { version } },
    ...failedStatusEvents(tenantId, requestId, failedMessages),
  ]);
}

/** The LAST write of a settle that changes no session: only `message.status`. */
export function emitFailedMessageStatuses(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  failedMessages: FailedMessage[],
): Promise<void> {
  return emitRealtimeEvents(
    tx,
    failedStatusEvents(tenantId, requestId, failedMessages),
  );
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
  // Lock order (verify F2): chat row BEFORE the message row, like the sweep,
  // the finish and the mirror. Joining the message only reads it (`OF c`).
  await tx.$queryRaw(Prisma.sql`
    SELECT c."id" FROM "chatbot_conversations" c
    JOIN "conversation_messages" m
      ON m."tenantId" = c."tenantId" AND m."conversationId" = c."id"
    WHERE m."tenantId" = ${tenantId} AND m."id" = ${input.messageId}
    FOR UPDATE OF c`);
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
    // The wamid is stored once; the one exception is the resend of a message
    // Meta refused for a closed window (S16 4): DEFERRED keeps the dead wamid
    // until the resend's own replaces it.
    if (
      input.providerMessageId &&
      (message.waMessageId === null || message.deliveryStatus === 'DEFERRED')
    ) {
      const [taken] = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
        SELECT 1 AS "one" FROM "conversation_messages"
        WHERE "tenantId" = ${tenantId} AND "waMessageId" = ${input.providerMessageId}
        LIMIT 1`);
      wamid = taken ? null : input.providerMessageId;
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "conversation_messages"
      SET "deliveryStatus" = ${input.status}::"ConversationDeliveryStatus",
          "waMessageId" = COALESCE(${wamid}, "waMessageId")
      WHERE "tenantId" = ${tenantId} AND "id" = ${input.messageId}`);
    status = input.status;
  }
  if (input.status === 'DEFERRED' && input.attemptedAt) {
    // The window closed no later than `attemptedAt`. Only the chat row is
    // written (lock order), and only forward.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_conversations"
      SET "windowClosedAt" = ${input.attemptedAt}, "updatedAt" = now()
      WHERE "tenantId" = ${tenantId} AND "id" = ${message.conversationId}
        AND ("windowClosedAt" IS NULL OR "windowClosedAt" < ${input.attemptedAt})`);
  }
  return { seq: message.seq, deliveryStatus: status };
}
