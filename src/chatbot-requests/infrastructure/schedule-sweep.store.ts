/**
 * The schedule sweep's batch (human-intervention unit 14; contract "Scheduled
 * conversations", §4.9.4, §4.9.6, S20 7 and 8). System flow on the root client:
 * every statement names its tenant. One candidate = ONE short transaction:
 *
 *   1. candidates are read without locks, oldest due first (`scheduleDueAt`,
 *      then id), `LIMIT n`, through the partial index
 *      `chatbot_requests_schedule_due_idx` (only rows with a due instant are in
 *      it, so a booked-but-not-due request costs nothing). A caller pages past
 *      rows it could not act on with the keyset `after`;
 *   2. the REQUEST row is taken `FOR UPDATE SKIP LOCKED` (a staff command or
 *      another replica holding it means "not now"), then re-read: a candidate
 *      whose `scheduleVersion` or `scheduleStage` moved (a reschedule, a cancel,
 *      another sweep) is stale and left alone, so an old stage can never fire
 *      for a time the request no longer has;
 *   3. `planScheduleStep` decides; the reminder feed item, the staff notice
 *      and the new stage commit together (lock order: request, settings
 *      share, feed, realtime).
 *
 * The "solicitud nueva" notice is held to the next opening when the branch is
 * closed at `scheduledFor` (L69, `noticeReleaseAt`). The SLA clocks need no
 * write here: booking and reschedule compute them from `scheduledFor`.
 *
 * Backstop for `needsReschedule` (S19 Q6): when a reminder falls due, a request
 * whose time is outside the CURRENT open hours is flagged then (the flag pass
 * of the settings change may have skipped it) and its reminder is suppressed.
 * No in-memory cursor: any number of replicas run side by side.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { enqueueNotice } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import type { OutboxClient } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import { emitRealtimeEvents } from '../../shared/realtime/realtime-event-writes';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { noticeReleaseAt } from '../domain/chatbot-sla-sweep';
import { newestInstant, windowClosesAtOf } from '../domain/scheduling-view';
import { REMINDER_LEAD_MINUTES } from '../domain/scheduling';
import { isStartStillOpen, planScheduleStep } from '../domain/schedule-sweep';
import { enqueueScheduledReminder } from './chatbot-feed-writes';
import type { TenantClient } from './chatbot-request-writes';
import { NEEDS_RESCHEDULE_CAUSE } from './scheduled-reschedule-flag';
import { describePrismaError } from './prisma-error-detail';
import { loadSchedulingConfig } from './scheduling-store';

export interface ScheduleSweepResult {
  candidates: number;
  reminders: number;
  notices: number;
  /** Requests flagged `needsReschedule` by the backstop. */
  flagged: number;
  /** Closed requests whose schedule was settled without output. */
  settled: number;
  /** Candidates a reschedule, cancel or another sweep moved first. */
  stale: number;
  /** Candidates that were locked or gone. */
  skipped: number;
  failed: number;
}

/** Keyset of `runBatch`: the (due instant, id) of the last candidate seen. */
export interface ScheduleDueCursor {
  dueAt: Date;
  id: string;
}

interface Candidate {
  id: string;
  tenantId: string;
  dueAt: Date;
  scheduleStage: number;
  scheduleVersion: number;
}

interface LockedRow {
  folio: number;
  subtype: string;
  status: string;
  version: number;
  conversationRef: string | null;
  scheduledFor: Date | null;
  scheduleStage: number;
  scheduleVersion: number;
  scheduleDueAt: Date | null;
  needsReschedule: boolean;
  requiresTemplateAtStart: boolean;
  lastCustomerMessageAt: Date | null;
  whatsappWindowClosesAt: Date | null;
}

/**
 * A candidate whose transaction threw keeps its `scheduleDueAt` and would sit
 * at the head of the due queue forever: enough of them (more than the rows one
 * tick reads) starve every genuine due row behind them. So a failure pushes that
 * row's due instant forward by this much, in its own short transaction; the row
 * is tried again later and the queue moves on. Fixed, so a poison row is retried
 * once a minute and never delays a reminder by more than that.
 */
export const FAILURE_BACKOFF_MS = 60_000;

type Outcome = keyof Omit<ScheduleSweepResult, 'candidates' | 'failed'>;

export const emptyScheduleResult = (): ScheduleSweepResult => ({
  candidates: 0,
  reminders: 0,
  notices: 0,
  flagged: 0,
  settled: 0,
  stale: 0,
  skipped: 0,
  failed: 0,
});

@Injectable()
export class ScheduleSweepStore {
  private readonly logger = new Logger(ScheduleSweepStore.name);
  readonly batchSize = 100;

  constructor(private readonly prisma: PrismaService) {}

  /** The candidates, oldest due first. Overridable seam of the specs. */
  protected readCandidates(
    now: Date,
    after: ScheduleDueCursor | null,
  ): Promise<Candidate[]> {
    return this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT r."id", r."tenantId", r."scheduleDueAt" AS "dueAt",
             r."scheduleStage", r."scheduleVersion"
      FROM "chatbot_requests" r
      WHERE r."scheduleDueAt" IS NOT NULL AND r."scheduleDueAt" <= ${now}
      ${after ? Prisma.sql`AND (r."scheduleDueAt", r."id") > (${after.dueAt}, ${after.id})` : Prisma.empty}
      ORDER BY r."scheduleDueAt", r."id" LIMIT ${this.batchSize}`);
  }

  async runBatch(
    now: Date = new Date(),
    after: ScheduleDueCursor | null = null,
  ): Promise<ScheduleSweepResult & { last: ScheduleDueCursor | null }> {
    const result = emptyScheduleResult();
    const candidates = await this.readCandidates(now, after);
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    const last = tail ? { dueAt: tail.dueAt, id: tail.id } : null;
    for (const candidate of candidates) {
      try {
        // SAFETY: `TenantClient` is the structural subset of the interactive
        // transaction client (`$queryRaw`, `$executeRaw`) that `handle` and
        // the write helpers use; every statement names its tenant explicitly.
        const outcome = await this.prisma.$transaction((tx) =>
          this.handle(tx as unknown as TenantClient, candidate, now),
        );
        // `notices` is an outcome kind of its own: counting `noticed` too
        // would count every notice twice.
        result[outcome.kind] += 1;
        if (outcome.flagged) result.flagged += 1;
      } catch (error) {
        result.failed += 1;
        // Ids and tenant only: no message, no customer data (A5).
        this.logger.error(
          `schedule sweep failed for request ${candidate.id} tenant ${candidate.tenantId}: ${describePrismaError(error)}`,
        );
        await this.backOff(candidate, now);
      }
    }
    return { ...result, last };
  }

  /**
   * Pushes a failed candidate's due instant `FAILURE_BACKOFF_MS` past `now`, in
   * its own transaction (the failed one rolled back). Guarded by the stage and
   * version the candidate was read with, so a reschedule or another sweep that
   * moved the row meanwhile is left alone, and `SKIP LOCKED`, so a staff command
   * holding the row is never waited for (the row simply stays due). Never
   * throws: a backoff that fails too only means the row is retried next tick.
   */
  private async backOff(candidate: Candidate, now: Date): Promise<void> {
    try {
      const retryAt = new Date(now.getTime() + FAILURE_BACKOFF_MS);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "chatbot_requests"
        SET "scheduleDueAt" = ${retryAt}
        WHERE "id" IN (
          SELECT "id" FROM "chatbot_requests"
          WHERE "tenantId" = ${candidate.tenantId} AND "id" = ${candidate.id}
            AND "scheduleDueAt" IS NOT NULL AND "scheduleDueAt" <= ${now}
            AND "scheduleVersion" = ${candidate.scheduleVersion}
            AND "scheduleStage" = ${candidate.scheduleStage}
          FOR UPDATE SKIP LOCKED)`);
    } catch (error) {
      this.logger.error(
        `schedule sweep backoff failed for request ${candidate.id} tenant ${candidate.tenantId}: ${describePrismaError(error)}`,
      );
    }
  }

  protected async handle(
    tx: TenantClient,
    candidate: Candidate,
    now: Date,
  ): Promise<{ kind: Outcome; flagged?: boolean; noticed?: boolean }> {
    const { id, tenantId } = candidate;
    const [row] = await tx.$queryRaw<LockedRow[]>(Prisma.sql`
      SELECT "folio", "subtype"::text AS "subtype", "status"::text AS "status",
             "version", "conversationRef", "scheduledFor", "scheduleStage",
             "scheduleVersion", "scheduleDueAt", "needsReschedule",
             "requiresTemplateAtStart", "lastCustomerMessageAt",
             "whatsappWindowClosesAt"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
      FOR UPDATE SKIP LOCKED`);
    if (!row) return { kind: 'skipped' };
    // Under the lock the row is the truth: a reschedule or cancel moved the
    // version (or cleared the due instant), another sweep moved the stage.
    if (
      !row.scheduledFor ||
      !row.scheduleDueAt ||
      row.scheduleDueAt.getTime() > now.getTime() ||
      row.scheduleVersion !== candidate.scheduleVersion ||
      row.scheduleStage !== candidate.scheduleStage
    ) {
      return { kind: 'stale' };
    }
    const closed = row.status !== 'NEW' && row.status !== 'IN_PROGRESS';
    const config = closed
      ? null
      : await loadSchedulingConfig(tx, tenantId, 'SHARE');
    const flag =
      config !== null &&
      row.scheduleStage === 0 &&
      row.status === 'NEW' &&
      !row.needsReschedule &&
      !isStartStillOpen(config.calendar, row.scheduledFor);
    const plan = planScheduleStep({
      stage: row.scheduleStage,
      scheduledFor: row.scheduledFor,
      now,
      status: row.status,
      needsReschedule: row.needsReschedule || flag,
    });

    if (plan.reminder && config) {
      const [chat] = row.conversationRef
        ? await tx.$queryRaw<Array<{ last: Date | null }>>(Prisma.sql`
            SELECT "lastCustomerMessageAt" AS "last"
            FROM "chatbot_conversations"
            WHERE "tenantId" = ${tenantId}
              AND "conversationRef" = ${row.conversationRef}`)
        : [];
      const last = newestInstant(row.lastCustomerMessageAt, chat?.last);
      await enqueueScheduledReminder(tx, tenantId, row.conversationRef, {
        requestId: id,
        scheduledFor: row.scheduledFor,
        scheduleVersion: row.scheduleVersion,
        minutesBefore: REMINDER_LEAD_MINUTES,
        timeZone: config.calendar.timeZone,
        whatsappWindowClosesAt: last
          ? windowClosesAtOf(last)
          : row.whatsappWindowClosesAt,
        requiresTemplateAtStart: row.requiresTemplateAtStart,
      });
    }
    let noticed = false;
    if (plan.notice && config) {
      // SAFETY: `OutboxClient` is the structural subset of the transaction
      // client that `enqueueNotice` uses; every notice names its own tenant.
      noticed = await enqueueNotice(
        tx as unknown as OutboxClient,
        tenantId,
        {
          type: 'REQUEST_CREATED',
          requestId: id,
          folio: row.folio,
          subtype: row.subtype,
          dedupKey: `created:${id}`,
        },
        // L69: held to the next opening while the branch is closed.
        noticeReleaseAt(config.calendar, now),
      );
    }
    // Guarded by the stage and version that were just read under the lock.
    // `version` moves only for the flag (the inbox row changed).
    const [updated] = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
      UPDATE "chatbot_requests"
      SET "scheduleStage" = ${plan.stage},
          "scheduleDueAt" = ${plan.dueAt ? plan.dueAt.toISOString() : null}::timestamp
          ${
            flag
              ? Prisma.sql`, "needsReschedule" = true, "version" = "version" + 1, "updatedAt" = now()`
              : Prisma.empty
          }
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
        AND "scheduleVersion" = ${row.scheduleVersion}
        AND "scheduleStage" = ${row.scheduleStage}
      RETURNING "version"`);
    if (flag && updated) {
      await emitRealtimeEvents(tx, [
        {
          tenantId,
          userId: null,
          type: 'request.updated',
          requestId: id,
          payload: { version: updated.version, cause: NEEDS_RESCHEDULE_CAUSE },
        },
      ]);
    }
    if (closed) return { kind: 'settled' };
    return {
      kind: plan.reminder ? 'reminders' : plan.notice ? 'notices' : 'settled',
      flagged: flag,
      noticed,
    };
  }
}
