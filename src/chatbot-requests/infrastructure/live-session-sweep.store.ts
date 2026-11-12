/**
 * The live session timeout sweep's batch (human-intervention unit 11; contract
 * §4.2, §4.6, §12.15, §10.1 R11). System flow on the root client: every
 * statement names its tenant. One candidate = ONE short transaction:
 *
 *   1. the candidates are read without locks, oldest due first, `LIMIT n`,
 *      through the partial indexes of the migration (STARTING / ENDING /
 *      ACTIVE);
 *   2. per candidate the REQUEST row is taken `FOR UPDATE SKIP LOCKED` (a staff
 *      command or another replica holding it means "not now", never a wait),
 *      then the session and the chat row are re-read under the lock and the
 *      pure rule (`dueSessionAction`) decides again, so a session that a
 *      session-ack or a customer message moved in between is left alone;
 *   3. the action runs in lock order (request, chat, feed, group, realtime).
 *
 * No in-memory cursor: any number of replicas run side by side. A candidate
 * that fails rolls back alone and is counted; it is picked up again next tick.
 * The sweep is not a staff command: only `START_TIMEOUT` (back to NEW) and the
 * idle end (RESOLVED) change the request, and both bump `version` (§12.8).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { enqueueNotice } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import type { OutboxClient } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import {
  dueSessionAction,
  SESSION_TIMING,
  type DueAction,
  type SessionState,
} from '../domain/live-session';
import {
  refreshCustomerGroup,
  type TenantClient,
} from './chatbot-request-writes';
import { slaColumnsForTransition } from './chatbot-sla-policy';
import {
  beginSessionEnding,
  emitSessionEvent,
  markEnded,
  revertStart,
} from './live-session-writes';

export interface SessionSweepResult {
  candidates: number;
  reverted: number;
  ended: number;
  idleEnded: number;
  /** T11d: live conversation notices written (customer wrote, 5 and 15 min). */
  noticed: number;
  skipped: number;
  failed: number;
}

interface Candidate {
  id: string;
  tenantId: string;
  requestId: string;
}

@Injectable()
export class LiveSessionSweepStore {
  private readonly logger = new Logger(LiveSessionSweepStore.name);
  readonly batchSize = 100;

  constructor(private readonly prisma: PrismaService) {}

  async runBatch(now: Date = new Date()): Promise<SessionSweepResult> {
    const result: SessionSweepResult = {
      candidates: 0,
      reverted: 0,
      ended: 0,
      idleEnded: 0,
      noticed: 0,
      skipped: 0,
      failed: 0,
    };
    // Sessions with a snapshot (every claim since slice 2) are due at their own
    // `startDeadlineAt`; older rows (no snapshot) at `startedAt` + the default.
    const startCut = new Date(now.getTime() - SESSION_TIMING.startTimeoutMs);
    const endCut = new Date(now.getTime() - SESSION_TIMING.endingTimeoutMs);
    // ACTIVE sessions are idle-checked against the chat's last customer
    // message too, so the cheap filter is the activation time only.
    const idleCut = new Date(now.getTime() - SESSION_TIMING.idleEndMs);
    const candidates = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT s."id", s."tenantId", s."requestId" FROM "chatbot_live_sessions" s
      WHERE (s."state" = 'STARTING' AND s."startDeadlineAt" <= ${now})
         OR (s."state" = 'STARTING' AND s."startDeadlineAt" IS NULL
             AND s."startedAt" <= ${startCut})
         OR (s."state" = 'ENDING' AND s."endingAt" <= ${endCut})
         OR (s."state" = 'ACTIVE' AND s."activeAt" <= ${idleCut})
      ORDER BY s."tenantId", s."id" LIMIT ${this.batchSize}`);
    result.candidates = candidates.length;
    for (const candidate of candidates) {
      try {
        const action = await this.prisma.$transaction((tx) =>
          this.handle(asTenantClient(tx), candidate, now),
        );
        if (action === null) result.skipped += 1;
        else if (action === 'REVERT_START') result.reverted += 1;
        else if (action === 'MARK_ENDED') result.ended += 1;
        else result.idleEnded += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `session sweep failed for session ${candidate.id}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return result;
  }

  /**
   * T11d (§4.6, §5.1): the notices of a live conversation, driven by the same
   * sweep (the mirror store belongs to unit 9, so nothing hooks the customer's
   * message; the sweep reads the chat's `lastCustomerMessageAt` instead).
   *
   * An ACTIVE session is waiting when the customer's newest message is later
   * than the attendee's last activity. Then, per session and per message:
   *   - "el cliente escribió" (`CONVERSATION_CUSTOMER_MESSAGE`, attendee) once
   *     per unanswered burst: not again while an earlier message of the burst
   *     is still unanswered;
   *   - 5 min unanswered (`CONVERSATION_UNANSWERED` level 5, the attendee) and
   *     15 min (level 15, whoever holds `update:ChatbotRequestAssignment`).
   *     Only the highest level due is sent (a sweep that was down for 16 min
   *     sends the 15-min notice, not both).
   * A newer customer message restarts the clock; an attendee message stops it.
   * The levels live on the session row, so replicas and restarts never repeat
   * a notice. These clocks never pause outside business hours (§4.6): the
   * notice is not held.
   */
  async runNoticeBatch(now: Date = new Date()): Promise<{ noticed: number }> {
    const candidates = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT s."id", s."tenantId", s."requestId"
      FROM "chatbot_live_sessions" s
      JOIN "chatbot_conversations" c
        ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
      WHERE s."state" = 'ACTIVE'
        AND c."lastCustomerMessageAt" > s."lastStaffActivityAt"
        AND (s."customerNoticeAt" IS DISTINCT FROM c."lastCustomerMessageAt"
             OR s."unansweredLevel" < 15)
      ORDER BY s."tenantId", s."id" LIMIT ${this.batchSize}`);
    let noticed = 0;
    for (const candidate of candidates) {
      try {
        noticed += await this.prisma.$transaction((tx) =>
          this.notify(asTenantClient(tx), candidate, now),
        );
      } catch (error) {
        this.logger.error(
          `session notice failed for session ${candidate.id}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return { noticed };
  }

  private async notify(
    tx: TenantClient,
    { id, tenantId, requestId }: Candidate,
    now: Date,
  ): Promise<number> {
    const [request] = await tx.$queryRaw<
      {
        folio: number;
        subtype: string;
        status: string;
        assigneeUserId: string | null;
      }[]
    >(Prisma.sql`
      SELECT "folio", "subtype"::text AS "subtype", "status"::text AS "status",
             "assigneeUserId"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}
      FOR UPDATE SKIP LOCKED`);
    if (!request?.assigneeUserId || request.status !== 'IN_PROGRESS') return 0;
    const [session] = await tx.$queryRaw<
      {
        state: string;
        lastStaffActivityAt: Date;
        customerNoticeAt: Date | null;
        unansweredLevel: number;
        lastCustomerMessageAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT s."state", s."lastStaffActivityAt", s."customerNoticeAt",
             s."unansweredLevel", c."lastCustomerMessageAt"
      FROM "chatbot_live_sessions" s
      JOIN "chatbot_conversations" c
        ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
      WHERE s."tenantId" = ${tenantId} AND s."id" = ${id}
      FOR UPDATE OF s, c`);
    const last = session?.lastCustomerMessageAt;
    if (
      !session ||
      session.state !== 'ACTIVE' ||
      !last ||
      last.getTime() <= session.lastStaffActivityAt.getTime()
    ) {
      return 0;
    }
    const lastMs = last.getTime();
    const base = {
      requestId,
      folio: request.folio,
      subtype: request.subtype,
    };
    const outbox = tx as unknown as OutboxClient;
    let written = 0;
    let level = session.unansweredLevel;
    if (session.customerNoticeAt?.getTime() !== lastMs) {
      // A new customer message. Tell the attendee only when the attendee spoke
      // since the last message this session noticed (a new burst).
      const firstOfBurst =
        !session.customerNoticeAt ||
        session.customerNoticeAt.getTime() <=
          session.lastStaffActivityAt.getTime();
      if (
        firstOfBurst &&
        (await enqueueNotice(outbox, tenantId, {
          ...base,
          type: 'CONVERSATION_CUSTOMER_MESSAGE',
          dedupKey: `wrote:${id}:${lastMs}`,
          recipientUserId: request.assigneeUserId,
        }))
      ) {
        written += 1;
      }
      level = 0;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_live_sessions"
        SET "customerNoticeAt" = ${last}, "unansweredLevel" = 0
        WHERE "tenantId" = ${tenantId} AND "id" = ${id}`);
    }
    const waited = now.getTime() - lastMs;
    const due =
      waited >= SESSION_TIMING.unansweredReassignMs
        ? 15
        : waited >= SESSION_TIMING.unansweredAttendeeMs
          ? 5
          : 0;
    if (due !== 0 && due > level) {
      await enqueueNotice(outbox, tenantId, {
        ...base,
        type: 'CONVERSATION_UNANSWERED',
        level: due,
        dedupKey: `unanswered:${due}:${id}:${lastMs}`,
        ...(due === 5 ? { recipientUserId: request.assigneeUserId } : {}),
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_live_sessions" SET "unansweredLevel" = ${due}
        WHERE "tenantId" = ${tenantId} AND "id" = ${id}`);
      written += 1;
    }
    return written;
  }

  private async handle(
    tx: TenantClient,
    { id, tenantId, requestId }: Candidate,
    now: Date,
  ): Promise<DueAction | null> {
    const [request] = await tx.$queryRaw<
      {
        id: string;
        status: string;
        conversationRef: string | null;
        customerKey: string;
        assigneeDisplayName: string | null;
        assigneeUserId: string | null;
      }[]
    >(Prisma.sql`
      SELECT "id", "status"::text AS "status", "conversationRef", "customerKey",
             "assigneeDisplayName", "assigneeUserId"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}
      FOR UPDATE SKIP LOCKED`);
    if (!request?.conversationRef) return null;
    const [session] = await tx.$queryRaw<
      {
        id: string;
        requestId: string;
        conversationId: string;
        epoch: number;
        state: SessionState;
        startedAt: Date;
        startDeadlineAt: Date | null;
        activeAt: Date | null;
        endingAt: Date | null;
        lastCustomerMessageAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT s."id", s."requestId", s."conversationId", s."epoch", s."state",
             s."startedAt", s."startDeadlineAt", s."activeAt", s."endingAt",
             c."lastCustomerMessageAt"
      FROM "chatbot_live_sessions" s
      JOIN "chatbot_conversations" c
        ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
      WHERE s."tenantId" = ${tenantId} AND s."id" = ${id}
      FOR UPDATE OF s, c`);
    if (!session) return null;
    const action = dueSessionAction(
      session,
      now,
      session.lastCustomerMessageAt,
    );
    if (action === null) return null;

    if (action === 'MARK_ENDED') {
      await markEnded(tx, session);
      const version = await bump(tx, tenantId, requestId);
      await emitSessionEvent(tx, tenantId, requestId, 'session.ended', version);
      return action;
    }

    if (action === 'REVERT_START') {
      await revertStart(tx, tenantId, session, request.conversationRef);
      const sla = await slaColumnsForTransition(
        tx,
        tenantId,
        requestId,
        'NEW',
        now,
      );
      const version = await bump(tx, tenantId, requestId);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "chatbot_requests"
        SET "status" = 'NEW', "assigneeUserId" = NULL, "assigneeDisplayName" = NULL,
            "claimedAt" = NULL
        WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}`);
      if (sla) {
        await tx.chatbotRequest.updateMany({
          where: { tenantId, id: requestId },
          data: sla,
        });
      }
      await tx.chatbotRequestEvent.create({
        data: {
          tenantId,
          requestId,
          type: 'AUTO_RELEASED',
          actorKind: 'SYSTEM',
          actorId: null,
          actorDisplayName: null,
          fromStatus: 'IN_PROGRESS',
          toStatus: 'NEW',
          version,
          data: {
            reason: 'START_TIMEOUT',
            handoffEpoch: session.epoch,
            ...(request.assigneeUserId
              ? {
                  previousAssignee: {
                    id: request.assigneeUserId,
                    displayName: request.assigneeDisplayName,
                  },
                }
              : {}),
          },
        },
      });
      await refreshCustomerGroup(tx, tenantId, request.customerKey);
      await emitSessionEvent(tx, tenantId, requestId, 'session.ended', version);
      return action;
    }

    // IDLE_END (§4.6): the customer was silent for 2 h. ACTIVE -> ENDING and
    // the request is RESOLVED with an automatic note; the bot says goodbye.
    const note =
      'Finalizada automáticamente: el cliente no contestó en 2 horas.';
    const version = await bump(tx, tenantId, requestId);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_requests"
      SET "status" = 'RESOLVED', "resolvedAt" = ${now}, "closedAt" = ${now},
          "nextSlaCheckAt" = NULL,
          "resolution" = ${JSON.stringify({ action: 'FINISH', note, auto: true })}::jsonb
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}`);
    await tx.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId,
        type: 'FINISHED',
        actorKind: 'SYSTEM',
        actorId: null,
        actorDisplayName: null,
        fromStatus: request.status as 'IN_PROGRESS',
        toStatus: 'RESOLVED',
        version,
        data: { note, auto: true, forced: false },
      },
    });
    const failed = await beginSessionEnding(
      tx,
      tenantId,
      session,
      request.conversationRef,
      'IDLE_TIMEOUT',
    );
    await refreshCustomerGroup(tx, tenantId, request.customerKey);
    await emitSessionEvent(
      tx,
      tenantId,
      requestId,
      'session.ending',
      version,
      failed,
    );
    return action;
  }
}

function asTenantClient(tx: Prisma.TransactionClient): TenantClient {
  // SAFETY: `TenantClient` is the tenant-extended client. The root transaction
  // client has the same `$queryRaw`, `$executeRaw` and model methods, and every
  // statement of the sweep names its own `tenantId` (a system flow), so the
  // tenant extension is never relied on.
  return tx as unknown as TenantClient;
}

async function bump(
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
