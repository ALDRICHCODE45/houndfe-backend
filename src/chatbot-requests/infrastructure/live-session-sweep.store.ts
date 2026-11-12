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
      skipped: 0,
      failed: 0,
    };
    const startCut = new Date(now.getTime() - SESSION_TIMING.startTimeoutMs);
    const endCut = new Date(now.getTime() - SESSION_TIMING.endingTimeoutMs);
    // ACTIVE sessions are idle-checked against the chat's last customer
    // message too, so the cheap filter is the activation time only.
    const idleCut = new Date(now.getTime() - SESSION_TIMING.idleEndMs);
    const candidates = await this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT s."id", s."tenantId", s."requestId" FROM "chatbot_live_sessions" s
      WHERE (s."state" = 'STARTING' AND s."startedAt" <= ${startCut})
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
        activeAt: Date | null;
        endingAt: Date | null;
        lastCustomerMessageAt: Date | null;
      }[]
    >(Prisma.sql`
      SELECT s."id", s."requestId", s."conversationId", s."epoch", s."state",
             s."startedAt", s."activeAt", s."endingAt", c."lastCustomerMessageAt"
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
    await beginSessionEnding(
      tx,
      tenantId,
      session,
      request.conversationRef,
      'IDLE_TIMEOUT',
    );
    await refreshCustomerGroup(tx, tenantId, request.customerKey);
    await emitSessionEvent(tx, tenantId, requestId, 'session.ending', version);
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
