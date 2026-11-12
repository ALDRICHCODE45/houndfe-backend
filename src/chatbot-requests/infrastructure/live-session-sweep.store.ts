/**
 * The live session timeout sweep's batch (human-intervention unit 11; contract
 * §4.2, §4.6, §12.15, §10.1 R11). System flow on the root client: every
 * statement names its tenant. One candidate = ONE short transaction:
 *
 *   1. the candidates are read without locks, oldest due first (each state's
 *      own due instant, then id), `LIMIT n`, through the partial indexes of the
 *      migration (STARTING / ENDING / ACTIVE). A caller pages past rows it
 *      could not act on with the keyset `after` (the last row it saw), so a
 *      run of skipped or failing rows never hides a due one behind it;
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
  emitFailedMessageStatuses,
  emitSessionEvent,
  failDeferredStaffMessages,
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
  /** S16 3 backstop: deferred staff messages settled FAILED by `runDeferredBatch`. */
  settledDeferred: number;
  skipped: number;
  /** Candidates whose transaction failed, plus failed notice / deferred rows. */
  failed: number;
}

/** Keyset of `runBatch`: the (due instant, id) of the last candidate seen. */
export interface DueCursor {
  dueAt: Date;
  id: string;
}

interface Candidate {
  id: string;
  tenantId: string;
  requestId: string;
}

interface DueCandidate extends Candidate {
  dueAt: Date;
}

/** A trusted constant (`SESSION_TIMING`), never user input. */
function msInterval(ms: number): Prisma.Sql {
  return Prisma.raw(`interval '${Math.trunc(ms)} milliseconds'`);
}

@Injectable()
export class LiveSessionSweepStore {
  private readonly logger = new Logger(LiveSessionSweepStore.name);
  readonly batchSize = 100;

  constructor(private readonly prisma: PrismaService) {}

  async runBatch(
    now: Date = new Date(),
    after: DueCursor | null = null,
  ): Promise<SessionSweepResult & { last: DueCursor | null }> {
    const result: SessionSweepResult = {
      candidates: 0,
      reverted: 0,
      ended: 0,
      idleEnded: 0,
      noticed: 0,
      settledDeferred: 0,
      skipped: 0,
      failed: 0,
    };
    // Sessions with a snapshot (every claim since slice 2) are due at their own
    // `startDeadlineAt`; older rows (no snapshot) at `startedAt` + the default.
    const startCut = new Date(now.getTime() - SESSION_TIMING.startTimeoutMs);
    const endCut = new Date(now.getTime() - SESSION_TIMING.endingTimeoutMs);
    const idleCut = new Date(now.getTime() - SESSION_TIMING.idleEndMs);
    // Only sessions that are DUE come back: one SELECT per state, each on its
    // own partial index of the migration (STARTING deadline / STARTING legacy /
    // ENDING / ACTIVE), joined by UNION ALL. The idle branch also requires the
    // chat's last customer message to be older than the idle cut (the same rule
    // `dueSessionAction` applies under the lock), so a long-running session
    // whose customer is still writing is never a candidate. A single OR over
    // the table made the planner walk (tenantId, id) and filter every row, and
    // not-due candidates filled the batch ahead of due ones (docs/perf/
    // unit-11-live-conversation.md).
    // `dueAt` is the instant the session became due (its own deadline, or the
    // state's start plus its timeout); the batch is read oldest due first.
    const candidates = await this.prisma.$queryRaw<DueCandidate[]>(Prisma.sql`
      SELECT d."id", d."tenantId", d."requestId", d."dueAt" FROM (
        SELECT s."id", s."tenantId", s."requestId",
               s."startDeadlineAt" AS "dueAt"
        FROM "chatbot_live_sessions" s
        WHERE s."state" = 'STARTING' AND s."startDeadlineAt" <= ${now}
        UNION ALL
        SELECT s."id", s."tenantId", s."requestId",
               s."startedAt" + ${msInterval(SESSION_TIMING.startTimeoutMs)}
        FROM "chatbot_live_sessions" s
        WHERE s."state" = 'STARTING' AND s."startDeadlineAt" IS NULL
          AND s."startedAt" <= ${startCut}
        UNION ALL
        SELECT s."id", s."tenantId", s."requestId",
               s."endingAt" + ${msInterval(SESSION_TIMING.endingTimeoutMs)}
        FROM "chatbot_live_sessions" s
        WHERE s."state" = 'ENDING' AND s."endingAt" <= ${endCut}
        UNION ALL
        SELECT s."id", s."tenantId", s."requestId",
               GREATEST(s."activeAt", COALESCE(c."lastCustomerMessageAt", s."activeAt"))
                 + ${msInterval(SESSION_TIMING.idleEndMs)}
        FROM "chatbot_live_sessions" s
        JOIN "chatbot_conversations" c
          ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
        WHERE s."state" = 'ACTIVE' AND s."activeAt" <= ${idleCut}
          AND (c."lastCustomerMessageAt" IS NULL
               OR c."lastCustomerMessageAt" <= ${idleCut})
      ) d
      ${after ? Prisma.sql`WHERE (d."dueAt", d."id") > (${after.dueAt}, ${after.id})` : Prisma.empty}
      ORDER BY d."dueAt", d."id" LIMIT ${this.batchSize}`);
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    const last: DueCursor | null = tail
      ? { dueAt: tail.dueAt, id: tail.id }
      : null;
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
    return { ...result, last };
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
  async runNoticeBatch(
    now: Date = new Date(),
  ): Promise<{ noticed: number; failed: number }> {
    // Only DUE sessions are candidates: a new customer message to announce, or
    // a level whose wait has elapsed (the same rule `notify` applies under the
    // lock). A waiting session that is not due yet used to stay a candidate
    // until its 15 min level was written, and with enough of them the batch of
    // 100 never reached the due ones. The request must also be one `notify`
    // acts on (IN_PROGRESS with an assignee: its first early return), or a
    // session of a closed or unheld request would stay a candidate forever.
    const fiveCut = new Date(
      now.getTime() - SESSION_TIMING.unansweredAttendeeMs,
    );
    const fifteenCut = new Date(
      now.getTime() - SESSION_TIMING.unansweredReassignMs,
    );
    const candidates = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT s."id", s."tenantId", s."requestId"
      FROM "chatbot_live_sessions" s
      JOIN "chatbot_conversations" c
        ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
      JOIN "chatbot_requests" r
        ON r."tenantId" = s."tenantId" AND r."id" = s."requestId"
      WHERE s."state" = 'ACTIVE'
        AND r."status" = 'IN_PROGRESS' AND r."assigneeUserId" IS NOT NULL
        AND c."lastCustomerMessageAt" > s."lastStaffActivityAt"
        AND (s."customerNoticeAt" IS DISTINCT FROM c."lastCustomerMessageAt"
             OR (s."unansweredLevel" < 5
                 AND c."lastCustomerMessageAt" <= ${fiveCut})
             OR (s."unansweredLevel" < 15
                 AND c."lastCustomerMessageAt" <= ${fifteenCut}))
      ORDER BY s."tenantId", s."id" LIMIT ${this.batchSize}`);
    let noticed = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        noticed += await this.prisma.$transaction((tx) =>
          this.notify(asTenantClient(tx), candidate, now),
        );
      } catch (error) {
        failed += 1;
        this.logger.error(
          `session notice failed for session ${candidate.id}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return { noticed, failed };
  }

  /**
   * S16 3 backstop (verify F1): a bot ACK `DEFERRED_WINDOW_CLOSED` that read
   * the session as ACTIVE just before staff finished can commit after the
   * finish skipped its item (`SKIP LOCKED`), leaving a deferred staff message
   * on an epoch that is over. The end transitions re-settle, but an ACK still
   * in flight at that moment can slip past too, so this settles whatever is
   * left. Only DUE rows are read: the partial index `chatbot_feed_items_
   * deferred_idx` holds just the few pending deferred items, and the
   * `NOT EXISTS (… ACTIVE)` keeps the waiting messages of live sessions out of
   * the batch (they would crowd out the due ones). One request per candidate,
   * one short transaction, request row `SKIP LOCKED` like the other phases.
   */
  async runDeferredBatch(): Promise<{
    settledDeferred: number;
    failed: number;
  }> {
    const candidates = await this.prisma.$queryRaw<
      Array<{ tenantId: string; requestId: string }>
    >(Prisma.sql`
      SELECT DISTINCT f."tenantId", f."requestId"
      FROM (
        SELECT f."tenantId", f."requestId", f."payload", f."cursor"
        FROM "chatbot_feed_items" f
        WHERE f."outcome" IN ('DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION')
          AND f."outcome" = 'DEFERRED_WINDOW_CLOSED'
          AND f."ackedAt" IS NULL
          AND f."type" = 'conversation.staff_message'
          AND NOT EXISTS (
            SELECT 1 FROM "chatbot_live_sessions" s
            WHERE s."tenantId" = f."tenantId" AND s."requestId" = f."requestId"
              AND s."epoch" = (f."payload"->>'handoffEpoch')::int
              AND s."state" = 'ACTIVE')
        ORDER BY f."cursor" LIMIT ${this.batchSize}
      ) f`);
    let settledDeferred = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        settledDeferred += await this.prisma.$transaction((tx) =>
          this.settleDeferred(asTenantClient(tx), candidate),
        );
      } catch (error) {
        failed += 1;
        this.logger.error(
          `deferred settle failed for request ${candidate.requestId}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return { settledDeferred, failed };
  }

  private async settleDeferred(
    tx: TenantClient,
    { tenantId, requestId }: { tenantId: string; requestId: string },
  ): Promise<number> {
    const [request] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}
      FOR UPDATE SKIP LOCKED`);
    if (!request) return 0;
    // Under the request lock: the newest epoch decides. Every earlier epoch is
    // over (one live session per chat); the newest only when it is not ACTIVE.
    const [latest] = await tx.$queryRaw<{ epoch: number; state: string }[]>(
      Prisma.sql`
      SELECT s."epoch", s."state" FROM "chatbot_live_sessions" s
      WHERE s."tenantId" = ${tenantId} AND s."requestId" = ${requestId}
      ORDER BY s."epoch" DESC LIMIT 1 FOR UPDATE`,
    );
    const upToEpoch = latest
      ? latest.state === 'ACTIVE'
        ? latest.epoch - 1
        : latest.epoch
      : Number.MAX_SAFE_INTEGER;
    const failed = await failDeferredStaffMessages(
      tx,
      tenantId,
      requestId,
      upToEpoch,
    );
    if (failed.length === 0) return 0;
    // The realtime lock is the last lock of the transaction. No version bump
    // and no `session.*` event: no request or session state changed, only
    // message statuses.
    await emitFailedMessageStatuses(tx, tenantId, requestId, failed);
    return failed.length;
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
    // SAFETY: `OutboxClient` is the structural subset of the transaction
    // client that `enqueueNotice` uses (`$queryRaw` / `$executeRaw`). `tx` is
    // the same root transaction client, and every notice names its own
    // `tenantId` (a system flow), so the tenant extension is never relied on.
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
      // S16 3 (verify F1): a window deferral whose ACK committed after the
      // finish skipped its item is settled at ENDED.
      const failed = await failDeferredStaffMessages(
        tx,
        tenantId,
        requestId,
        session.epoch,
      );
      const version = await bump(tx, tenantId, requestId);
      await emitSessionEvent(
        tx,
        tenantId,
        requestId,
        'session.ended',
        version,
        failed,
      );
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
