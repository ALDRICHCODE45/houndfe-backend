/**
 * restock-backorder / T2b (contract v1 §4) — the backorder sweep's batches.
 * Same shape as the pay-in-store hold sweep (`sale-hold-sweep.store.ts`): every
 * candidate is ONE short transaction, candidates are read WITHOUT locks through
 * partial indexes (cross-tenant, the root client), then each runs in its tenant
 * (`runWithTenant`) and one tenant transaction that RE-CHECKS under the lock.
 * A candidate another transaction moved is `stale`, a locked one is `skipped`;
 * a throwing one is backed off in memory (60 s, per process) so a poison row
 * never sits at the head of every tick. No in-memory cursor: any number of
 * replicas run side by side (SKIP LOCKED + the stage/status re-check make the
 * second one a no-op).
 *
 * Three phases, in this order:
 *
 *  1. DUE TIMERS (`runDueBatch`): RESERVED rows with `reservationStage` < 2 whose
 *     reminder or deadline passed. Under the row lock `planReservationStep`
 *     decides: stage 0 and `reminderAt` passed → stage 1 + `backorder.reservation_reminder`;
 *     `reservedUntil` passed → EXPIRED (`expiredAt`, stage 2), release through
 *     `BackorderReservationService` (the journal runs the allocator for the next
 *     WAITING one in the same transaction), `backorder.reservation_expired`
 *     and the staff notice (RESERVED → EXPIRED, §9.5).
 *  2. LOTS (`runLotBatch`): RESERVED rows that still hold units of a lot that
 *     expired → `revalidateReservation`: SWAPPED (silent), RESERVATION_LOST
 *     (`backorder.reservation_lost`; back to WAITING at its place), NOT_HELD
 *     (a data fault: logged and left alone, never "repaired").
 *  3. SAFETY NET (`runAllocateBatch`): products/variants with a WAITING queue and
 *     enough sellable stock for its smallest backorder → `allocate` again. The
 *     primary trigger is the journal's increase listener (same transaction as
 *     the stock write); this catches what that savepoint rolled back or an
 *     intake that raced an arrival.
 *
 *  4. OVERDUE ETA (`runReestimateBatch`, T4; contract §8, D6): WAITING backorders
 *     with `estimatedAt` in the past and etaStage 0, grouped by (tenant, product,
 *     variant) → `BackorderReestimateService.requestForGroup` (ONE decision per
 *     product, attach the group, customer told nothing). It is the only phase
 *     whose candidate runs OUTSIDE a transaction (the RESTOCK intake opens its
 *     own); the service re-checks every row under its own locks.
 *  5. ETA REPAIR (`runReestimateApplyBatch`): an already-RESOLVED re-estimate
 *     decision with a backorder still WAITING + etaStage 1 (it was RESERVED when
 *     the answer fanned out, or the listener's savepoint rolled back) → apply
 *     the answer (`backorder.eta_updated` / `eta_unavailable`).
 *
 * LOCK ORDER (L7): stock (`StockJournalWriter.lockStock`) BEFORE any backorder
 * row lock, and the feed's advisory lock LAST. Expiry therefore locks the
 * product's stock first and only then takes the backorder row (`SKIP LOCKED`);
 * the reminder needs no stock and takes the row alone. A reminder whose row
 * turns out to be due for expiry under the lock is left for the next tick (it
 * has not taken the stock lock). The lot phase delegates to
 * `revalidateReservation`, which takes stock first and the row second (a plain
 * `FOR UPDATE` there: it waits behind a bot cancel instead of skipping, which
 * is fine because the cancel took the stock lock first too).
 *
 * Race with the bot cancel: both lock the stock first, so they serialize; the
 * loser re-reads the status under the row lock and sees EXPIRED/CANCELLED
 * (sweep: `stale`; cancel: `BACKORDER_NOT_CANCELLABLE`). Units are released once
 * (the journal releases `reserves − releases`).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describePrismaError } from '../../chatbot-requests/infrastructure/prisma-error-detail';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { enqueueBackorderExpiredNotice } from '../../notifications/infrastructure/backorder-notice.writer';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import { LowStockCrossing } from '../../stock-alerts/infrastructure/low-stock-crossing.service';
import {
  BACKORDER_SYSTEM_ACTOR,
  BackorderAllocator,
} from '../application/backorder-allocator';
import { BackorderReservationService } from '../application/backorder-reservation.service';
import { planReservationStep, STAGE_AFTER } from '../domain/backorder-sweep';
import { BackorderReestimateService } from './backorder-reestimate.service';
import type { BackorderStatusValue } from '../domain/backorder-status';
import {
  backorderNoticeSubject,
  enqueueBackorderReservationExpired,
  enqueueBackorderReservationLost,
  enqueueBackorderReservationReminder,
} from './backorder-feed-writes';

export interface BackorderSweepResult {
  candidates: number;
  /** `backorder.reservation_reminder` sent (stage 0 → 1). */
  reminders: number;
  /** RESERVED → EXPIRED. */
  expired: number;
  /** An expired lot was replaced by valid stock (silent). */
  swapped: number;
  /** RESERVED → WAITING (`backorder.reservation_lost`). */
  lost: number;
  /** RESERVED but the journal holds nothing for it (logged, left alone). */
  notHeld: number;
  /** Backorders reserved by the safety-net allocation. */
  allocated: number;
  /** Re-estimate decisions created (T4): one per product/variant at a time. */
  reestimates: number;
  /** Overdue backorders attached to a re-estimate decision (T4, customer told nothing). */
  attached: number;
  /** Backorders answered by the repair phase (T4). */
  etaApplied: number;
  /** Candidates another transaction or sweep moved first, or nothing to do. */
  stale: number;
  /** Candidates that were locked or gone. */
  skipped: number;
  failed: number;
}

export const emptyBackorderSweepResult = (): BackorderSweepResult => ({
  candidates: 0,
  reminders: 0,
  expired: 0,
  swapped: 0,
  lost: 0,
  notHeld: 0,
  allocated: 0,
  reestimates: 0,
  attached: 0,
  etaApplied: 0,
  stale: 0,
  skipped: 0,
  failed: 0,
});

/** Keyset of the due phase: the (deadline, id) of the last candidate seen. */
export interface DueCursor {
  reservedUntil: Date;
  id: string;
}
/** Keyset of the lot phase: the id of the last candidate seen. */
export interface LotCursor {
  id: string;
}
/** Keyset of the safety-net phase. */
export interface QueueCursor {
  tenantId: string;
  productId: string;
  variantKey: string;
}

/** Keyset of the overdue-ETA phase (same shape as the safety net's). */
export type EtaCursor = QueueCursor;
/** Keyset of the ETA repair phase. */
export interface EtaApplyCursor {
  tenantId: string;
  decisionId: string;
}

interface EtaApplyCandidate {
  tenantId: string;
  decisionId: string;
}

interface DueCandidate {
  id: string;
  tenantId: string;
  productId: string;
  reservedUntil: Date;
}
interface LotCandidate {
  id: string;
  tenantId: string;
}
interface QueueCandidate {
  tenantId: string;
  productId: string;
  variantId: string | null;
  variantKey: string;
}

interface LockedBackorder {
  status: BackorderStatusValue;
  reservationStage: number;
  reservedUntil: Date | null;
  reminderAt: Date | null;
  productId: string;
  variantId: string | null;
  quantity: number;
}

/** The reminder is always `reservedUntil − 3 h`: bounds the due query on its index. */
const REMINDER_LEAD_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** A failed candidate is not retried before this (per process). */
export const BACKORDER_FAILURE_BACKOFF_MS = 60_000;
/** Bound of the in-memory backoff list (oldest entries dropped first). */
const MAX_BACKED_OFF = 1_000;

type Counter = keyof Omit<BackorderSweepResult, 'candidates' | 'failed'>;

@Injectable()
export class BackorderSweepStore {
  private readonly logger = new Logger(BackorderSweepStore.name);
  readonly batchSize = 100;
  /** `kind:id` -> instant before which it is not retried. */
  private readonly backoff = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly tenantRunner: TenantRunnerService,
    private readonly journal: StockJournalWriter,
    private readonly reservations: BackorderReservationService,
    private readonly allocator: BackorderAllocator,
    private readonly crossing: LowStockCrossing,
    private readonly reestimates: BackorderReestimateService,
  ) {}

  // ---------------------------------------------------------------- phase 1

  /** The due candidates, oldest deadline first. Overridable seam of the specs. */
  protected readDueCandidates(
    now: Date,
    after: DueCursor | null,
    excluded: string[],
  ): Promise<DueCandidate[]> {
    const horizon = new Date(now.getTime() + REMINDER_LEAD_MS);
    return this.prisma.$queryRaw<DueCandidate[]>(Prisma.sql`
      SELECT b."id", b."tenantId", b."productId", b."reservedUntil"
      FROM "backorders" b
      WHERE b."status" = 'RESERVED' AND b."reservationStage" < 2
        AND b."reservedUntil" IS NOT NULL
        AND b."reservedUntil" <= ${horizon}
        AND (b."reservedUntil" <= ${now}
             OR (b."reservationStage" = 0 AND b."reminderAt" IS NOT NULL
                 AND b."reminderAt" <= ${now}))
      ${after ? Prisma.sql`AND (b."reservedUntil", b."id") > (${after.reservedUntil}, ${after.id})` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND b."id" NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      ORDER BY b."reservedUntil", b."id" LIMIT ${this.batchSize}`);
  }

  async runDueBatch(
    now: Date,
    after: DueCursor | null,
  ): Promise<BackorderSweepResult & { last: DueCursor | null }> {
    const result = emptyBackorderSweepResult();
    const candidates = await this.readDueCandidates(
      now,
      after,
      this.backedOff('due', now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      await this.guarded(
        result,
        'due',
        candidate.id,
        candidate.tenantId,
        now,
        () => this.handleDue(candidate, now),
      );
    }
    return {
      ...result,
      last: tail ? { reservedUntil: tail.reservedUntil, id: tail.id } : null,
    };
  }

  private async handleDue(
    candidate: DueCandidate,
    now: Date,
  ): Promise<Counter> {
    const tx = this.tenantPrisma.getClient();
    const { id, tenantId } = candidate;
    // Stock BEFORE the backorder row, but only when the candidate is due for
    // expiry: a reminder moves no stock and must not queue behind sales.
    const mayExpire = candidate.reservedUntil.getTime() <= now.getTime();
    if (mayExpire) await this.journal.lockStock([candidate.productId]);

    const [row] = await tx.$queryRaw<LockedBackorder[]>(Prisma.sql`
      SELECT "status"::text AS "status", "reservationStage", "reservedUntil",
             "reminderAt", "productId", "variantId", "quantity"
      FROM "backorders"
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
      FOR UPDATE SKIP LOCKED`);
    if (!row) return 'skipped';

    // Under the lock the row is the truth: a cancel, a confirmation, a lot loss
    // or another replica moved it.
    const plan = planReservationStep(row, now);
    if (plan.kind === 'wait') return 'stale';

    if (plan.kind === 'remind') {
      await this.setStage(
        tenantId,
        id,
        row.reservationStage,
        STAGE_AFTER.remind,
      );
      await enqueueBackorderReservationReminder(tx, tenantId, id);
      return 'reminders';
    }

    // Expiry. The stock lock was not taken when the candidate was only a
    // reminder: leave it for the next tick instead of breaking the lock order.
    if (!mayExpire) return 'stale';
    await tx.backorder.update({
      where: { id, tenantId },
      data: {
        status: 'EXPIRED',
        expiredAt: now,
        reservationStage: STAGE_AFTER.expire,
        version: { increment: 1 },
      },
    });
    // Journal release + the allocator for the next WAITING backorder (same
    // transaction, stock already locked) + the low-stock edge.
    await this.reservations.releaseReservation({
      tenantId,
      backorderId: id,
      productId: row.productId,
      variantId: row.variantId,
      quantity: row.quantity,
      actor: BACKORDER_SYSTEM_ACTOR,
      now,
    });
    // Outbox, then the feed lock last.
    await enqueueBackorderExpiredNotice(
      tx,
      tenantId,
      await backorderNoticeSubject(tx, tenantId, id),
    );
    await enqueueBackorderReservationExpired(tx, tenantId, id);
    return 'expired';
  }

  private async setStage(
    tenantId: string,
    id: string,
    from: number,
    to: number,
  ): Promise<void> {
    // Guarded by the stage read under the lock.
    await this.tenantPrisma.getClient().$executeRaw(Prisma.sql`
      UPDATE "backorders" SET "reservationStage" = ${to}
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
        AND "reservationStage" = ${from}`);
  }

  // ---------------------------------------------------------------- phase 2

  /**
   * RESERVED rows that still hold units (reserves − releases > 0) of a lot whose
   * expiry may have passed. `startOfUtcDay(now) + 1 day` is a superset bound of
   * "expired in any business time zone" (a lot is expired when its date is
   * before today's local date, never later than tomorrow UTC); the journal's own
   * check under the locks decides, so an over-inclusive row answers `VALID`.
   */
  protected readLotCandidates(
    now: Date,
    after: LotCursor | null,
    excluded: string[],
  ): Promise<LotCandidate[]> {
    const bound = new Date(
      Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS,
    );
    return this.prisma.$queryRaw<LotCandidate[]>(Prisma.sql`
      SELECT b."id", b."tenantId"
      FROM "backorders" b
      WHERE b."status" = 'RESERVED' AND b."reservationStage" < 2
        AND EXISTS (
          SELECT 1 FROM "stock_movements" m
          JOIN "lots" l ON l."id" = m."lotId" AND l."tenantId" = m."tenantId"
          WHERE m."tenantId" = b."tenantId" AND m."groupType" = 'BACKORDER'
            AND m."groupId" = b."id"
            AND m."type" IN ('BACKORDER_RESERVE', 'BACKORDER_RELEASE')
            AND m."lotId" IS NOT NULL AND l."expirationDate" < ${bound}
          GROUP BY m."lotId" HAVING sum(m."delta") < 0)
      ${after ? Prisma.sql`AND b."id" > ${after.id}` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND b."id" NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      ORDER BY b."id" LIMIT ${this.batchSize}`);
  }

  async runLotBatch(
    now: Date,
    after: LotCursor | null,
  ): Promise<BackorderSweepResult & { last: LotCursor | null }> {
    const result = emptyBackorderSweepResult();
    const candidates = await this.readLotCandidates(
      now,
      after,
      this.backedOff('lot', now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      await this.guarded(
        result,
        'lot',
        candidate.id,
        candidate.tenantId,
        now,
        () => this.handleLot(candidate, now),
      );
    }
    return { ...result, last: tail ? { id: tail.id } : null };
  }

  private async handleLot(
    candidate: LotCandidate,
    now: Date,
  ): Promise<Counter> {
    const tx = this.tenantPrisma.getClient();
    const { id, tenantId } = candidate;
    const outcome = await this.reservations.revalidateReservation(tx, id, now);
    switch (outcome.outcome) {
      case 'SWAPPED':
        return 'swapped';
      case 'RESERVATION_LOST':
        // The row is WAITING again (version bumped) and the freed units already
        // went to whoever fits (their `backorder.reserved` was enqueued by the
        // allocator's hook); now tell this customer. Feed lock last.
        await enqueueBackorderReservationLost(tx, tenantId, id);
        return 'lost';
      case 'NOT_HELD':
        // A RESERVED backorder the journal holds nothing for is a data fault
        // (a manual edit, a half-restored backup). It is reported on every tick
        // that finds it and NOT repaired: releasing nothing and re-queueing it
        // would hide the fault, expiring it at the deadline is the safe end.
        this.logger.warn(
          `backorder ${id} tenant ${tenantId} is RESERVED but the journal holds nothing for it; left as is (it will expire at its deadline)`,
        );
        return 'notHeld';
      default:
        return 'stale';
    }
  }

  // ---------------------------------------------------------------- phase 3

  /**
   * Queues that can serve at least their smallest backorder: WAITING backorders
   * grouped by (tenant, product, variant) joined to the stock they could take.
   * `quantity` is a pre-filter (it still counts units in expired lots); the
   * allocator decides under the locks.
   */
  protected readQueueCandidates(
    after: QueueCursor | null,
    excluded: string[],
  ): Promise<QueueCandidate[]> {
    return this.prisma.$queryRaw<QueueCandidate[]>(Prisma.sql`
      SELECT q."tenantId", q."productId", q."variantId",
             COALESCE(q."variantId", '') AS "variantKey"
      FROM (
        SELECT b."tenantId", b."productId", b."variantId",
               min(b."quantity") AS "minQuantity"
        FROM "backorders" b WHERE b."status" = 'WAITING'
        GROUP BY b."tenantId", b."productId", b."variantId") q
      LEFT JOIN "products" p
        ON p."id" = q."productId" AND p."tenantId" = q."tenantId"
      LEFT JOIN "variants" v ON v."id" = q."variantId"
      WHERE ((q."variantId" IS NULL AND p."useStock" = true
              AND p."quantity" >= q."minQuantity")
             OR (q."variantId" IS NOT NULL AND v."quantity" >= q."minQuantity"))
      ${after ? Prisma.sql`AND (q."tenantId", q."productId", COALESCE(q."variantId", '')) > (${after.tenantId}, ${after.productId}, ${after.variantKey})` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND (q."tenantId" || ':' || q."productId" || ':' || COALESCE(q."variantId", '')) NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      ORDER BY q."tenantId", q."productId", COALESCE(q."variantId", '')
      LIMIT ${this.batchSize}`);
  }

  async runAllocateBatch(
    now: Date,
    after: QueueCursor | null,
  ): Promise<BackorderSweepResult & { last: QueueCursor | null }> {
    const result = emptyBackorderSweepResult();
    const candidates = await this.readQueueCandidates(
      after,
      this.backedOff('queue', now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      const key = `${candidate.tenantId}:${candidate.productId}:${candidate.variantKey}`;
      await this.guarded(result, 'queue', key, candidate.tenantId, now, () =>
        this.handleQueue(candidate, now, result),
      );
    }
    return {
      ...result,
      last: tail
        ? {
            tenantId: tail.tenantId,
            productId: tail.productId,
            variantKey: tail.variantKey,
          }
        : null,
    };
  }

  /** Counts the backorders it reserved itself (`allocated`); returns the per-candidate outcome. */
  private async handleQueue(
    candidate: QueueCandidate,
    now: Date,
    result: BackorderSweepResult,
  ): Promise<Counter | null> {
    const tx = this.tenantPrisma.getClient();
    // Stock locks first, then the queue (inside `allocate`).
    const allocation = await this.allocator.allocate(
      tx,
      candidate.tenantId,
      candidate.productId,
      candidate.variantId,
      now,
    );
    await this.crossing.record(allocation.movements);
    result.allocated += allocation.reservedIds.length;
    return allocation.reservedIds.length > 0 ? null : 'stale';
  }

  // ---------------------------------------------------------------- phase 4

  /**
   * Products/variants with at least one overdue, not yet asked backorder
   * (WAITING, etaStage 0, `estimatedAt < now`): one row per group, the unit of
   * the «one re-estimate per product» rule.
   */
  protected readEtaCandidates(
    now: Date,
    after: EtaCursor | null,
    excluded: string[],
  ): Promise<QueueCandidate[]> {
    return this.prisma.$queryRaw<QueueCandidate[]>(Prisma.sql`
      SELECT b."tenantId", b."productId", b."variantId",
             COALESCE(b."variantId", '') AS "variantKey"
      FROM "backorders" b
      WHERE b."status" = 'WAITING' AND b."etaStage" = 0
        AND b."estimatedAt" < ${now}
      ${after ? Prisma.sql`AND (b."tenantId", b."productId", COALESCE(b."variantId", '')) > (${after.tenantId}, ${after.productId}, ${after.variantKey})` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND (b."tenantId" || ':' || b."productId" || ':' || COALESCE(b."variantId", '')) NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      GROUP BY b."tenantId", b."productId", b."variantId"
      ORDER BY b."tenantId", b."productId", COALESCE(b."variantId", '')
      LIMIT ${this.batchSize}`);
  }

  async runReestimateBatch(
    now: Date,
    after: EtaCursor | null,
  ): Promise<BackorderSweepResult & { last: EtaCursor | null }> {
    const result = emptyBackorderSweepResult();
    const candidates = await this.readEtaCandidates(
      now,
      after,
      this.backedOff('eta', now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      const key = `${candidate.tenantId}:${candidate.productId}:${candidate.variantKey}`;
      await this.guarded(
        result,
        'eta',
        key,
        candidate.tenantId,
        now,
        async () => {
          const outcome = await this.reestimates.requestForGroup(
            {
              tenantId: candidate.tenantId,
              productId: candidate.productId,
              variantId: candidate.variantId,
            },
            now,
          );
          if (outcome.created) result.reestimates += 1;
          result.attached += outcome.attached;
          return outcome.attached > 0 || outcome.created ? null : 'stale';
        },
        // The RESTOCK intake opens its own transaction and refuses to nest.
        { transactional: false },
      );
    }
    return {
      ...result,
      last: tail
        ? {
            tenantId: tail.tenantId,
            productId: tail.productId,
            variantKey: tail.variantKey,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------- phase 5

  /** Resolved re-estimate decisions that still have a WAITING etaStage-1 backorder. */
  protected readEtaApplyCandidates(
    after: EtaApplyCursor | null,
    excluded: string[],
  ): Promise<EtaApplyCandidate[]> {
    return this.prisma.$queryRaw<EtaApplyCandidate[]>(Prisma.sql`
      SELECT DISTINCT b."tenantId", b."reestimateDecisionId" AS "decisionId"
      FROM "backorders" b
      JOIN "human_decisions" d
        ON d."id" = b."reestimateDecisionId" AND d."tenantId" = b."tenantId"
      WHERE b."status" = 'WAITING' AND b."etaStage" = 1
        AND d."status" = 'RESOLVED'
      ${after ? Prisma.sql`AND (b."tenantId", b."reestimateDecisionId") > (${after.tenantId}, ${after.decisionId})` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND (b."tenantId" || ':' || b."reestimateDecisionId") NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      ORDER BY b."tenantId", b."reestimateDecisionId"
      LIMIT ${this.batchSize}`);
  }

  async runReestimateApplyBatch(
    now: Date,
    after: EtaApplyCursor | null,
  ): Promise<BackorderSweepResult & { last: EtaApplyCursor | null }> {
    const result = emptyBackorderSweepResult();
    const candidates = await this.readEtaApplyCandidates(
      after,
      this.backedOff('etaApply', now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      const key = `${candidate.tenantId}:${candidate.decisionId}`;
      await this.guarded(
        result,
        'etaApply',
        key,
        candidate.tenantId,
        now,
        async () => {
          const answered = await this.reestimates.applyResolvedDecision(
            this.tenantPrisma.getClient(),
            candidate.tenantId,
            candidate.decisionId,
          );
          result.etaApplied += answered;
          return answered > 0 ? null : 'stale';
        },
      );
    }
    return {
      ...result,
      last: tail
        ? { tenantId: tail.tenantId, decisionId: tail.decisionId }
        : null,
    };
  }

  // ---------------------------------------------------------------- shared

  /**
   * One candidate in its tenant and its own transaction. `null` from `work`
   * means the work counted itself (the safety net counts reserved backorders).
   */
  private async guarded(
    result: BackorderSweepResult,
    kind: string,
    key: string,
    tenantId: string,
    now: Date,
    work: () => Promise<Counter | null>,
    options: { transactional?: boolean } = {},
  ): Promise<void> {
    try {
      const outcome = await this.tenantRunner.runWithTenant(tenantId, () =>
        options.transactional === false
          ? work()
          : this.tenantPrisma.runInTransaction(work),
      );
      if (outcome !== null) result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      // Ids and tenant only: no customer data in logs.
      this.logger.error(
        `backorder sweep (${kind}) failed for ${key} tenant ${tenantId}: ${describePrismaError(error)}`,
      );
      this.backOff(kind, key, now);
    }
  }

  private backOff(kind: string, key: string, now: Date): void {
    const id = `${kind}:${key}`;
    this.backoff.delete(id);
    this.backoff.set(id, now.getTime() + BACKORDER_FAILURE_BACKOFF_MS);
    while (this.backoff.size > MAX_BACKED_OFF) {
      const oldest = this.backoff.keys().next().value as string;
      this.backoff.delete(oldest);
    }
  }

  /** Keys of `kind` still backed off at `now`; expired entries are dropped. */
  private backedOff(kind: string, now: Date): string[] {
    const keys: string[] = [];
    for (const [id, until] of this.backoff) {
      if (until <= now.getTime()) this.backoff.delete(id);
      else if (id.startsWith(`${kind}:`)) keys.push(id.slice(kind.length + 1));
    }
    return keys;
  }
}
