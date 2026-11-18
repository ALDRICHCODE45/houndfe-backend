/**
 * pay-in-store-pickup / T2 (S2, S3, S4) — the hold sweep's batch. Same shape
 * as the schedule sweep (`schedule-sweep.store.ts`). One candidate = ONE
 * short transaction:
 *
 *   1. candidates are read WITHOUT locks through the partial index
 *      `sales_hold_due_idx` (CONFIRMED, `holdStage` < 2, deadline set), due
 *      when the reminder is due (stage 0) or the deadline passed. The reminder
 *      is always exactly 3 h before the deadline, so the query bounds
 *      `holdExpiresAt <= now + 3 h` and stays on the index. Oldest deadline
 *      first, keyset (`holdExpiresAt`, id) so a caller pages past rows it
 *      could not act on;
 *   2. inside the tenant runner (sale use cases read the tenant from CLS) and
 *      one tenant transaction, the SALE row is taken `FOR UPDATE SKIP LOCKED`
 *      (a payment, a staff hold edit or another replica holding it means
 *      "not now"), then re-read: a candidate whose `holdVersion`, `holdStage`
 *      or `paymentIntent` moved is stale and left alone;
 *   3. `planHoldStep` decides from the locked row (and, at the deadline, the
 *      sale's PENDING receipts); the feed item / cancellation / staff notice
 *      (+ T6 / S12 `sale.pickup_expired_review` for the bot) and the new
 *      `holdStage` commit together, guarded by the version and stage read
 *      under the lock (`applyStep`, shared with the manual expiry
 *      `expireNow`, T6 / S11).
 *
 * Lock order: the sale row first, then whatever the cancellation takes
 * (stock journal, promotion counters, outbox), and the feed's per-tenant
 * advisory lock LAST (the `sale.pickup_*` enqueue). Nothing takes a sale row
 * while holding the feed lock, so the sweep and a receipt confirmation or a
 * staff hold edit never deadlock.
 *
 * A candidate whose transaction throws is backed off in memory (no column to
 * push: the deadline is the customer's), so a poison row never sits at the
 * head of every tick. No in-memory cursor: any number of replicas run side by
 * side (SKIP LOCKED + the stage guard make the second one a no-op).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  enqueuePickupExpired,
  enqueuePickupExpiredReview,
  enqueuePickupReminder,
} from '../chatbot-requests/infrastructure/sale-feed-writes';
import { describePrismaError } from '../chatbot-requests/infrastructure/prisma-error-detail';
import { enqueueSaleHoldReviewNotice } from '../notifications/infrastructure/sale-hold-notice.writer';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantRunnerService } from '../shared/tenant/tenant-runner.service';
import { HOLD_REMINDER_LEAD_MS, HOLD_STAGE } from './domain/sale-hold';
import {
  planHoldStep,
  STAGE_AFTER,
  type HoldSweepPlan,
} from './domain/sale-hold-sweep';
import { saleHoldError } from './sale-hold.service';
import { SalesService } from './sales.service';

export interface HoldSweepResult {
  candidates: number;
  /** Customer reminders enqueued (`sale.pickup_reminder`). */
  reminders: number;
  /** Sales cancelled HOLD_EXPIRED (`sale.pickup_expired`). */
  expired: number;
  /** S4: staff notices (payment or pending receipt, no cancel). */
  reviews: number;
  /** Holds closed without output (paid, cancelled, handed over, partial reminder). */
  settled: number;
  /** Candidates a staff edit, a payment or another sweep moved first. */
  stale: number;
  /** Candidates that were locked or gone. */
  skipped: number;
  failed: number;
}

/** Keyset of `runBatch`: the (deadline, id) of the last candidate seen. */
export interface HoldDueCursor {
  expiresAt: Date;
  id: string;
}

export interface HoldCandidate {
  id: string;
  tenantId: string;
  holdExpiresAt: Date;
  holdStage: number;
  holdVersion: number;
  paymentIntent: string | null;
}

interface LockedSale {
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  paidCents: number;
  deliveryStatus: string;
  customerId: string | null;
  paymentIntent: string | null;
  holdExpiresAt: Date | null;
  holdReminderAt: Date | null;
  holdStage: number;
  holdVersion: number;
}

/** The locked read of one sale (sweep and manual expiry). */
const LOCKED_SALE_COLUMNS = Prisma.sql`
      SELECT "folio", "status"::text AS "status",
             "paymentStatus"::text AS "paymentStatus", "paidCents",
             "deliveryStatus"::text AS "deliveryStatus", "customerId",
             "paymentIntent"::text AS "paymentIntent", "holdExpiresAt",
             "holdReminderAt", "holdStage", "holdVersion"
      FROM "sales"`;

type Outcome = keyof Omit<HoldSweepResult, 'candidates' | 'failed'>;

/** T6 — result of a manual expiry (POST /sales/:id/hold/expire `outcome`). */
export type ManualExpiryOutcome = 'CANCELLED' | 'REVIEW' | 'SETTLED';

const MANUAL_OUTCOME: Partial<
  Record<HoldSweepPlan['kind'], ManualExpiryOutcome>
> = {
  expire: 'CANCELLED',
  review: 'REVIEW',
  settle: 'SETTLED',
};

/** A failed candidate is not retried before this (per process). */
export const HOLD_FAILURE_BACKOFF_MS = 60_000;
/** Bound of the in-memory backoff list (oldest entries dropped first). */
const MAX_BACKED_OFF = 1_000;

export const emptyHoldResult = (): HoldSweepResult => ({
  candidates: 0,
  reminders: 0,
  expired: 0,
  reviews: 0,
  settled: 0,
  stale: 0,
  skipped: 0,
  failed: 0,
});

@Injectable()
export class SaleHoldSweepStore {
  private readonly logger = new Logger(SaleHoldSweepStore.name);
  readonly batchSize = 100;
  /** Sale id -> instant before which it is not retried. */
  private readonly backoff = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly tenantRunner: TenantRunnerService,
    private readonly sales: SalesService,
  ) {}

  /** The due candidates, oldest deadline first. Overridable seam of the specs. */
  protected readCandidates(
    now: Date,
    after: HoldDueCursor | null,
    excluded: string[],
  ): Promise<HoldCandidate[]> {
    const reminderHorizon = new Date(now.getTime() + HOLD_REMINDER_LEAD_MS);
    return this.prisma.$queryRaw<HoldCandidate[]>(Prisma.sql`
      SELECT s."id", s."tenantId", s."holdExpiresAt", s."holdStage",
             s."holdVersion", s."paymentIntent"::text AS "paymentIntent"
      FROM "sales" s
      WHERE s."status" = 'CONFIRMED' AND s."holdStage" < 2
        AND s."holdExpiresAt" IS NOT NULL
        AND s."holdExpiresAt" <= ${reminderHorizon}
        AND (s."holdExpiresAt" <= ${now}
             OR (s."holdStage" = 0 AND s."holdReminderAt" IS NOT NULL
                 AND s."holdReminderAt" <= ${now}))
      ${after ? Prisma.sql`AND (s."holdExpiresAt", s."id") > (${after.expiresAt}, ${after.id})` : Prisma.empty}
      ${excluded.length > 0 ? Prisma.sql`AND s."id" NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
      ORDER BY s."holdExpiresAt", s."id" LIMIT ${this.batchSize}`);
  }

  async runBatch(
    now: Date = new Date(),
    after: HoldDueCursor | null = null,
  ): Promise<HoldSweepResult & { last: HoldDueCursor | null }> {
    const result = emptyHoldResult();
    const candidates = await this.readCandidates(
      now,
      after,
      this.backedOff(now),
    );
    result.candidates = candidates.length;
    const tail = candidates[candidates.length - 1];
    const last = tail ? { expiresAt: tail.holdExpiresAt, id: tail.id } : null;
    for (const candidate of candidates) {
      try {
        const outcome = await this.tenantRunner.runWithTenant(
          candidate.tenantId,
          () =>
            this.tenantPrisma.runInTransaction(() =>
              this.handle(candidate, now),
            ),
        );
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        // Ids and tenant only: no customer data in logs.
        this.logger.error(
          `hold sweep failed for sale ${candidate.id} tenant ${candidate.tenantId}: ${describePrismaError(error)}`,
        );
        this.backOff(candidate.id, now);
      }
    }
    return { ...result, last };
  }

  private backOff(saleId: string, now: Date): void {
    this.backoff.delete(saleId);
    this.backoff.set(saleId, now.getTime() + HOLD_FAILURE_BACKOFF_MS);
    while (this.backoff.size > MAX_BACKED_OFF) {
      const oldest = this.backoff.keys().next().value as string;
      this.backoff.delete(oldest);
    }
  }

  /** Ids still backed off at `now`; expired entries are dropped. */
  private backedOff(now: Date): string[] {
    const ids: string[] = [];
    for (const [id, until] of this.backoff) {
      if (until > now.getTime()) ids.push(id);
      else this.backoff.delete(id);
    }
    return ids;
  }

  protected async handle(
    candidate: HoldCandidate,
    now: Date,
  ): Promise<Outcome> {
    const tx = this.tenantPrisma.getClient();
    const { id, tenantId } = candidate;
    const [row] = await tx.$queryRaw<LockedSale[]>(Prisma.sql`
      ${LOCKED_SALE_COLUMNS}
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
      FOR UPDATE SKIP LOCKED`);
    if (!row) return 'skipped';
    // Under the lock the row is the truth: a staff edit moved the version, a
    // replica moved the stage.
    if (
      row.holdVersion !== candidate.holdVersion ||
      row.holdStage !== candidate.holdStage ||
      row.paymentIntent !== candidate.paymentIntent ||
      row.paymentIntent !== 'IN_STORE'
    ) {
      return 'stale';
    }

    const { plan, outcome } = await this.applyStep(tenantId, id, row, now);
    return plan.kind === 'wait' ? 'stale' : outcome;
  }

  /**
   * pay-in-store-pickup / T6 (S11) — «Vencer apartado ahora»: the sweep's
   * expiry decision for ONE sale, applied now by a staff member. Runs inside
   * the caller's tenant transaction (the endpoint's, with its idempotency
   * slot), so an error rolls everything back.
   *
   * The sale row is taken `FOR UPDATE` (waiting, not SKIP LOCKED: a staff
   * request must get an answer, and a sweep or payment holding the row
   * finishes first), then checked: IN_STORE, `holdStage` < 2, CONFIRMED,
   * `holdVersion` == `expectedVersion`. The decision is `planHoldStep` and
   * its effects are `applyStep`, the sweep's own code, evaluated as of the
   * deadline (`max(now, holdExpiresAt)`): the hold is treated as lapsed, so
   * the plan is always the expiry stage (expire / review / settle), never a
   * reminder. The only difference from the sweep: a cancellation is by the
   * acting user (`canceledByUserId`, stock actor), not the system.
   *
   * Race with the sweep: whoever locks the row first applies stage 2; the
   * other sees stage 2 (manual: HOLD_ALREADY_CLOSED) or a moved stage (sweep:
   * stale), so the sale is cancelled once.
   */
  async expireNow(
    saleId: string,
    actorUserId: string,
    expectedVersion: number,
    now: Date = new Date(),
  ): Promise<ManualExpiryOutcome> {
    if (!this.tenantPrisma.isInTransaction()) {
      throw new Error('expireNow must run inside a tenant transaction');
    }
    const tx = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const [row] = await tx.$queryRaw<LockedSale[]>(Prisma.sql`
      ${LOCKED_SALE_COLUMNS}
      WHERE "tenantId" = ${tenantId} AND "id" = ${saleId}
      FOR UPDATE`);
    // Drafts stay private to the POS draft endpoints (as PATCH /hold).
    if (!row || row.status === 'DRAFT') {
      throw saleHoldError(404, 'SALE_NOT_FOUND');
    }
    if (row.paymentIntent !== 'IN_STORE') {
      throw saleHoldError(409, 'SALE_NOT_PAY_IN_STORE');
    }
    if (row.holdStage >= HOLD_STAGE.EXPIRED) {
      throw saleHoldError(409, 'HOLD_ALREADY_CLOSED');
    }
    if (row.status !== 'CONFIRMED' || row.holdExpiresAt === null) {
      throw saleHoldError(409, 'SALE_HOLD_NOT_EDITABLE');
    }
    if (row.holdVersion !== expectedVersion) {
      throw saleHoldError(409, 'HOLD_VERSION_CONFLICT');
    }

    const decisionAt = new Date(
      Math.max(now.getTime(), row.holdExpiresAt.getTime()),
    );
    const { plan } = await this.applyStep(tenantId, saleId, row, decisionAt, {
      userId: actorUserId,
    });
    const outcome = MANUAL_OUTCOME[plan.kind];
    if (!outcome) {
      // Unreachable: at the deadline the plan is always an expiry plan.
      throw new Error(`manual hold expiry: unexpected plan ${plan.kind}`);
    }
    return outcome;
  }

  /**
   * One step of the hold flow on a sale row the caller holds `FOR UPDATE`
   * and has already checked (version, stage, intent): `planHoldStep` at
   * `now`, its effects (feed item, cancellation, staff notice) and the new
   * `holdStage`, all on the caller's transaction. Shared by the sweep and
   * the manual expiry (`actor` set: the cancellation is that user's).
   */
  private async applyStep(
    tenantId: string,
    id: string,
    row: LockedSale,
    now: Date,
    actor?: { userId: string },
  ): Promise<{ plan: HoldSweepPlan; outcome: Outcome }> {
    const tx = this.tenantPrisma.getClient();
    const expired =
      row.holdExpiresAt !== null &&
      row.holdExpiresAt.getTime() <= now.getTime();
    const pendingReceipt =
      expired && row.status === 'CONFIRMED'
        ? await this.hasPendingReceipt(tenantId, id)
        : false;
    const plan = planHoldStep(
      {
        status: row.status,
        paymentStatus: row.paymentStatus,
        paidCents: row.paidCents,
        deliveryStatus: row.deliveryStatus,
        holdStage: row.holdStage,
        holdExpiresAt: row.holdExpiresAt,
        holdReminderAt: row.holdReminderAt,
        pendingReceipt,
      },
      now,
    );
    if (plan.kind === 'wait') return { plan, outcome: 'stale' };

    const feedSale = {
      id,
      folio: row.folio,
      holdExpiresAt: row.holdExpiresAt,
      customerId: row.customerId,
    };
    let outcome: Outcome;
    switch (plan.kind) {
      case 'remind':
        // The bot's checkout always sets a customer; none = nobody to tell.
        if (row.customerId !== null) {
          await enqueuePickupReminder(tx, tenantId, feedSale, row.holdVersion);
        }
        outcome = 'reminders';
        break;
      case 'expire':
        await this.sales.expireHeldSale(id, actor);
        // Feed lock last (after the sale, stock and outbox writes).
        if (row.customerId !== null) {
          await enqueuePickupExpired(tx, tenantId, feedSale, row.holdVersion);
        }
        outcome = 'expired';
        break;
      case 'review':
        await enqueueSaleHoldReviewNotice(tx, tenantId, {
          id,
          folio: row.folio,
          holdVersion: row.holdVersion,
          reason: plan.reason,
        });
        // T6 / S12: the bot learns the hold lapsed without a cancel.
        if (row.customerId !== null) {
          await enqueuePickupExpiredReview(
            tx,
            tenantId,
            feedSale,
            row.holdVersion,
          );
        }
        outcome = 'reviews';
        break;
      default:
        outcome = 'settled';
    }

    // Guarded by the version and stage read under the lock.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "sales" SET "holdStage" = ${STAGE_AFTER[plan.kind]}
      WHERE "tenantId" = ${tenantId} AND "id" = ${id}
        AND "holdVersion" = ${row.holdVersion}
        AND "holdStage" = ${row.holdStage}`);
    return { plan, outcome };
  }

  private async hasPendingReceipt(
    tenantId: string,
    saleId: string,
  ): Promise<boolean> {
    const rows = await this.tenantPrisma.getClient().$queryRaw<unknown[]>(
      Prisma.sql`
        SELECT 1 FROM "receipt_evidences"
        WHERE "tenantId" = ${tenantId} AND "saleId" = ${saleId}
          AND "status" = 'PENDING'
        LIMIT 1`,
    );
    return rows.length > 0;
  }
}
