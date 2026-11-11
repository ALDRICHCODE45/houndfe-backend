/**
 * The SLA sweep's batch (human-intervention unit 7c; contract §5.4, §10.1
 * R11). One call is ONE bounded batch in ONE short transaction on the root
 * client (the sweep runs outside any HTTP request, so every statement carries
 * an explicit `tenantId`).
 *
 * Two phases select their rows with `FOR UPDATE OF r SKIP LOCKED LIMIT n`, so
 * any number of replicas run side by side, never wait for each other or for a
 * staff command, and keep NO in-memory cursor:
 *
 *   `due`    open requests with `nextSlaCheckAt <= now` (the partial index of
 *            the first migration serves it): the milestone instants.
 *   `stale`  open requests stamped with an older `slaPolicyVersion` than their
 *            tenant's current settings (or none): rows a settings change could
 *            not recompute (PARTIAL or FAILED recompute, a crash between the
 *            PUT and the recompute, a row a command held). They are recomputed
 *            with the current policy and watched from there.
 *
 * Per row (see `planSweep`): the milestones reached are written as
 * SLA_MILESTONE events (`INSERT … ON CONFLICT DO NOTHING` on the unique index
 * of migration 20261111070000, the DURABLE dedup: events are kept forever,
 * unlike the 90-day notifications); only a milestone that was actually
 * inserted enqueues its notice (outbox row, deduplicated per user by the same
 * key) and the first overdue marks `overdueAt` and feeds the bot once. The row
 * ends with its next check (NULL when nothing is left). `version` and
 * `updatedAt` are not touched: the sweep is not a staff command (it must not
 * make a staff CAS fail) and the bot recovery route must not see it as a
 * change.
 *
 * Lock order: request rows (one statement) → per-tenant feed advisory lock
 * (only for a first overdue; tenants in ascending order, so two sweeps never
 * cross) → customer groups last, in sorted order (docs/chatbot-requests-model.md).
 * Settings rows are read `FOR SHARE` after the request rows, the order every
 * command uses.
 *
 * Isolation: each row runs inside a SAVEPOINT. A row that fails is rolled back
 * to its savepoint, logged by id (never customer data) and pushed out by
 * `failureBackoffMs`, so one poison row cannot abort the batch or starve the
 * rows behind it.
 */
import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { enqueueNotice } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import type { OutboxClient } from '../../notifications/infrastructure/chatbot-request-notice.writer';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { SettingsSubtype } from '../../chatbot-settings/domain/chatbot-attention-settings';
import {
  milestoneKey,
  noticeReleaseAt,
  planSweep,
  type SweepPlan,
} from '../domain/chatbot-sla-sweep';
import { enqueueOverdueNotice } from './chatbot-feed-writes';
import {
  refreshCustomerGroups,
  type TenantClient,
} from './chatbot-request-writes';
import { LAST_RELEASED, loadSlaPolicy, type RawDb } from './chatbot-sla-policy';
import type { SlaPolicy } from '../domain/chatbot-sla';

export const SLA_SWEEP_OPTIONS = Symbol.for('ChatbotSlaSweepOptions');

export interface ChatbotSlaSweepOptions {
  /** Injected clock (tests, DST and closed-day crossings). */
  clock?: () => Date;
  /** Rows per batch. Default 100 (contract). */
  batchSize?: number;
  /** Push-out of a row that failed. Default 5 min. */
  failureBackoffMs?: number;
}

export type SweepPhase = 'due' | 'stale';

export interface SweepBatchResult {
  phase: SweepPhase;
  /** Rows locked and visited. */
  rows: number;
  /** SLA_MILESTONE events inserted. */
  milestones: number;
  /** Notices written to the notifications outbox. */
  notices: number;
  /** `request.overdue_notice` feed items inserted. */
  feedItems: number;
  /** Stale rows recomputed. */
  recomputed: number;
  /** Rows rolled back to their savepoint. */
  failed: number;
}

interface SweepRowRecord {
  id: string;
  tenantId: string;
  folio: number;
  kind: string;
  subtype: SettingsSubtype;
  status: 'NEW' | 'IN_PROGRESS';
  version: number;
  customerKey: string;
  conversationRef: string | null;
  assigneeUserId: string | null;
  createdAt: Date;
  scheduledFor: Date | null;
  overdueAt: Date | null;
  slaPolicyVersion: number | null;
  lastReleasedAt: Date | null;
}

const DEFAULT_BATCH = 100;
const DEFAULT_BACKOFF_MS = 5 * 60_000;
const OPEN = Prisma.sql`r."status" IN ('NEW', 'IN_PROGRESS')`;

/** `timestamp(3)` columns hold UTC wall time: ISO text cast without a zone. */
const ts = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

const COLUMNS = Prisma.sql`
  r."id", r."tenantId", r."folio", r."kind"::text AS "kind",
  r."subtype"::text AS "subtype", r."status"::text AS "status", r."version",
  r."customerKey", r."conversationRef", r."assigneeUserId", r."createdAt",
  r."scheduledFor", r."overdueAt", r."slaPolicyVersion",
  ${LAST_RELEASED} AS "lastReleasedAt"`;

@Injectable()
export class ChatbotSlaSweepStore {
  private readonly logger = new Logger(ChatbotSlaSweepStore.name);
  private readonly clock: () => Date;
  readonly batchSize: number;
  private readonly failureBackoffMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SLA_SWEEP_OPTIONS)
    options: ChatbotSlaSweepOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_BACKOFF_MS;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error('batchSize must be a positive integer');
    }
  }

  /** One bounded batch of a phase, in one transaction. */
  runBatch(phase: SweepPhase): Promise<SweepBatchResult> {
    const now = this.clock();
    return this.prisma.$transaction((tx) => this.batch(tx, phase, now), {
      timeout: 30_000,
      maxWait: 5_000,
    });
  }

  private async lockRows(
    tx: Prisma.TransactionClient,
    phase: SweepPhase,
    now: Date,
  ): Promise<SweepRowRecord[]> {
    const at = ts(now);
    const rows =
      phase === 'due'
        ? await tx.$queryRaw<SweepRowRecord[]>(Prisma.sql`
            SELECT ${COLUMNS} FROM "chatbot_requests" r
            WHERE ${OPEN} AND r."nextSlaCheckAt" <= ${at}::timestamp
            ORDER BY r."nextSlaCheckAt", r."id"
            LIMIT ${this.batchSize}
            FOR UPDATE OF r SKIP LOCKED`)
        : await tx.$queryRaw<SweepRowRecord[]>(Prisma.sql`
            SELECT ${COLUMNS} FROM "chatbot_requests" r
            WHERE ${OPEN}
              AND coalesce(r."slaPolicyVersion", -1) < coalesce(
                (SELECT s."version" FROM "chatbot_attention_settings" s
                 WHERE s."tenantId" = r."tenantId"), 0)
            ORDER BY r."id"
            LIMIT ${this.batchSize}
            FOR UPDATE OF r SKIP LOCKED`);
    // Ascending tenant order: the per-tenant feed advisory locks of a batch are
    // then always taken in the same order by every replica.
    return rows.sort(
      (a, b) =>
        (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  private async recordedKeys(
    tx: Prisma.TransactionClient,
    rows: SweepRowRecord[],
  ): Promise<Map<string, Set<string>>> {
    const recorded = await tx.$queryRaw<
      { requestId: string; clock: string; milestone: string; cycle: string }[]
    >(Prisma.sql`
      SELECT e."requestId", e."data" ->> 'clock' AS "clock",
             e."data" ->> 'milestone' AS "milestone", e."data" ->> 'cycle' AS "cycle"
      FROM "chatbot_request_events" e
      WHERE e."type" = 'SLA_MILESTONE'
        AND e."tenantId" = ANY(${[...new Set(rows.map((r) => r.tenantId))]}::text[])
        AND e."requestId" = ANY(${rows.map((r) => r.id)}::text[])`);
    const byRequest = new Map<string, Set<string>>();
    for (const event of recorded) {
      const keys = byRequest.get(event.requestId) ?? new Set<string>();
      keys.add(`${event.clock}:${event.milestone}:${event.cycle}`);
      byRequest.set(event.requestId, keys);
    }
    return byRequest;
  }

  private async batch(
    tx: Prisma.TransactionClient,
    phase: SweepPhase,
    now: Date,
  ): Promise<SweepBatchResult> {
    const result: SweepBatchResult = {
      phase,
      rows: 0,
      milestones: 0,
      notices: 0,
      feedItems: 0,
      recomputed: 0,
      failed: 0,
    };
    const rows = await this.lockRows(tx, phase, now);
    result.rows = rows.length;
    if (rows.length === 0) return result;

    const policies = new Map<string, SlaPolicy>();
    for (const tenantId of [...new Set(rows.map((r) => r.tenantId))]) {
      policies.set(
        tenantId,
        await loadSlaPolicy(tx as RawDb, tenantId, { lock: true }),
      );
    }
    const recorded = await this.recordedKeys(tx, rows);
    const groups = new Map<string, Set<string>>();

    for (const row of rows) {
      await tx.$executeRaw`SAVEPOINT sla_row`;
      try {
        const policy = policies.get(row.tenantId) as SlaPolicy;
        const plan = planSweep(
          policy,
          { ...row, lastReleasedAt: row.lastReleasedAt },
          recorded.get(row.id) ?? new Set(),
          now,
        );
        const touchedGroup = await this.apply(
          tx,
          row,
          plan,
          policy,
          now,
          result,
        );
        await tx.$executeRaw`RELEASE SAVEPOINT sla_row`;
        if (touchedGroup) {
          const keys = groups.get(row.tenantId) ?? new Set<string>();
          keys.add(row.customerKey);
          groups.set(row.tenantId, keys);
        }
      } catch (error) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT sla_row`;
        result.failed += 1;
        // Ids only: never customer data in a log.
        this.logger.error(
          `sla sweep row failed (${row.id}, tenant ${row.tenantId}): ${
            error instanceof Error ? error.message.slice(0, 200) : 'unknown'
          }`,
        );
        const retryAt = new Date(now.getTime() + this.failureBackoffMs);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chatbot_requests"
          SET "nextSlaCheckAt" = ${ts(retryAt)}::timestamp
          WHERE "tenantId" = ${row.tenantId} AND "id" = ${row.id}`);
        await tx.$executeRaw`RELEASE SAVEPOINT sla_row`;
      }
    }
    // Customer groups last, tenants and keys in sorted order.
    for (const tenantId of [...groups.keys()].sort()) {
      // SAFETY: `refreshCustomerGroups` only runs raw SQL with an explicit
      // tenantId; the transaction client has the same `$queryRaw` and
      // `$executeRaw` as the tenant-extended client it is typed against.
      await refreshCustomerGroups(
        tx as unknown as TenantClient,
        tenantId,
        groups.get(tenantId) ?? [],
      );
    }
    return result;
  }

  /** Writes one row's plan. Returns `true` when its customer group changed. */
  private async apply(
    tx: Prisma.TransactionClient,
    row: SweepRowRecord,
    plan: SweepPlan,
    policy: SlaPolicy,
    now: Date,
    result: SweepBatchResult,
  ): Promise<boolean> {
    // Staff notices wait for the tenant's next opening while the calendar is
    // closed (L69); the milestone itself is recorded now.
    const releaseAt = noticeReleaseAt(policy.calendar, now);
    let overdueMarked = false;
    let notified: SweepPlan['milestones'][number] | null = null;
    let overdueInserted = false;
    for (const planned of plan.milestones) {
      const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "chatbot_request_events"
          ("id", "tenantId", "requestId", "type", "actorKind", "fromStatus",
           "toStatus", "version", "data", "createdAt")
        VALUES (gen_random_uuid()::text, ${row.tenantId}, ${row.id},
                'SLA_MILESTONE'::"ChatbotRequestEventType",
                'SYSTEM'::"ChatbotRequestActorKind",
                ${row.status}::"ChatbotRequestStatus",
                ${row.status}::"ChatbotRequestStatus", ${row.version},
                ${JSON.stringify({
                  milestone: planned.milestone,
                  clock: plan.clock,
                  cycle: String(plan.cycle),
                  dueAt: planned.at.toISOString(),
                  notice: planned.notice,
                  ...(planned.notice && releaseAt
                    ? { noticeNotBefore: releaseAt.toISOString() }
                    : {}),
                  // First overdue only: was the customer told (24 h rule)?
                  ...(planned.milestone === 'OVERDUE' && plan.customerNotice
                    ? { customerNotice: plan.customerNotice }
                    : {}),
                })}::jsonb, now())
        ON CONFLICT ("tenantId", "requestId", (("data" ->> 'clock')),
                    (("data" ->> 'milestone')), (("data" ->> 'cycle')))
          WHERE "type" = 'SLA_MILESTONE'
        DO NOTHING
        RETURNING "id"`);
      if (inserted.length === 0) continue; // someone recorded it: never twice
      result.milestones += 1;
      if (planned.notice) notified = planned;
      if (planned.milestone === 'OVERDUE') overdueInserted = true;
    }
    if (notified?.notice && plan.clock && plan.cycle !== null) {
      // SAFETY: the root transaction client has the `outboxEvent` model the
      // producer uses; only the tenant-extension typing differs.
      const written = await enqueueNotice(
        tx as unknown as OutboxClient,
        row.tenantId,
        {
          type: notified.notice,
          requestId: row.id,
          folio: row.folio,
          subtype: row.subtype,
          dedupKey: `sla:${row.id}:${milestoneKey(plan.clock, notified.milestone, plan.cycle)}`,
          ...(notified.withAssignee && row.assigneeUserId
            ? { recipientUserId: row.assigneeUserId }
            : {}),
          // A held reminder is dropped if the claim cycle moved on (release).
          ...(notified.notice === 'REQUEST_CLAIM_REMINDER'
            ? { claimCycle: plan.cycle }
            : {}),
        },
        releaseAt,
      );
      if (written) result.notices += 1;
    }
    if (overdueInserted && plan.firstOverdueAt && plan.clock) {
      overdueMarked = true;
      // Owner decision (L69): an overdue that expired 24 h or more ago is not
      // told to the customer; `overdueAt`, the event and the staff notice stay.
      // SAFETY: `enqueueOverdueNotice` only runs raw SQL with an explicit
      // tenantId, which the root transaction client supports like the
      // tenant-extended one it is typed against.
      const fed =
        plan.customerNotice === 'SENT' &&
        (await enqueueOverdueNotice(
          tx as unknown as TenantClient,
          row.tenantId,
          {
            requestId: row.id,
            folio: row.folio,
            kind: row.kind,
            subtype: row.subtype,
            clock: plan.clock,
            deadlineAt: plan.firstOverdueAt,
            assigned: row.status === 'IN_PROGRESS',
            conversationRef: row.conversationRef,
          },
        ));
      if (fed) result.feedItems += 1;
    }

    const columns = plan.columns;
    if (columns) result.recomputed += 1;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_requests" r
      SET "nextSlaCheckAt" = ${ts(plan.nextSlaCheckAt)}::timestamp,
          "overdueAt" = coalesce(r."overdueAt", ${ts(overdueMarked ? plan.firstOverdueAt : null)}::timestamp)
          ${
            columns
              ? Prisma.sql`,
                "claimDeadlineAt" = ${
                  columns.claimDeadlineAt === undefined
                    ? Prisma.sql`r."claimDeadlineAt"`
                    : Prisma.sql`${ts(columns.claimDeadlineAt)}::timestamp`
                },
                "resolveDeadlineAt" = ${ts(columns.resolveDeadlineAt)}::timestamp,
                "slaPolicyVersion" = ${columns.slaPolicyVersion}`
              : Prisma.empty
          }
      WHERE r."tenantId" = ${row.tenantId} AND r."id" = ${row.id}
        AND ${OPEN}`);
    return overdueMarked || columns !== null;
  }
}
