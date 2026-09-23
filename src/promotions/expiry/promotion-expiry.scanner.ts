/**
 * PromotionExpiryScanner — pca-3c2.
 *
 * Bounded scheduled producer of promotion-expiration alert candidates. Each
 * tick reads at most `batchSize` effectively ACTIVE promotions that end inside
 * `(now, now + 7d]` and hands every candidate to the committed atomic claim
 * port (`PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY`), which owns the locked
 * tenant-qualified re-read, the end-date-fingerprint dedupe, and the
 * transactional outbox write.
 *
 * Why the scanner does not decide eligibility on its own: it runs outside the
 * HTTP CLS context, so it injects the GLOBAL `PrismaService` (never the
 * tenant-scoped client, which needs an ambient request context) and treats its
 * read as a best-effort candidate list. The claim revalidates the locked row,
 * so a stale, edited, or already-alerted promotion resolves safely there.
 *
 * Eligibility is derived from DATES ONLY — the persisted `status` column can be
 * stale after a date edit and is never consulted. A row is eligible when:
 *   - `manuallyEnded = FALSE` (permanent operator override), and
 *   - `endDate IS NOT NULL` (no end date means no expiration alert), and
 *   - `endDate > now` (not already expired), and
 *   - `endDate <= now + 7 days` (inside the alert window), and
 *   - `startDate IS NULL OR startDate <= now` (excludes scheduled/not-started).
 * The window literal is single-sourced from
 * `PROMOTION_EXPIRY_ALERT_WINDOW_DAYS` so the scanner and the claim can never
 * drift apart.
 *
 * Bounded work, no overlap, no starvation:
 *   - one tick claims at most `batchSize` candidates;
 *   - a tick already in flight makes the next tick a no-op (the guard is
 *     released in `finally`, so a failure never wedges the scanner);
 *   - a per-item claim failure is isolated and counted, never aborting the
 *     batch;
 *   - a batch-read failure is logged and swallowed so it never rejects out of
 *     the `@Interval` tick;
 *   - an in-memory rotation cursor advances past the last scanned id and wraps
 *     to the start once the due set is exhausted, so a due set larger than the
 *     batch cap is fully covered across ticks instead of starving its tail.
 *
 * Inert by design: this module is NOT registered in `AppModule`. Registering it
 * now would publish `promotion.expiring.detected` rows that the generic
 * fire-and-forget outbox poller could consume before the dedicated poller and
 * its exclusion exist. `pca-3c4c` activates the scanner together with the
 * complete delivery path.
 *
 * Spec: promotion-capacity-alerts task pca-3c2. The claim port/outbox contract
 * is owned by pca-3c1a; the delivery dispatcher/poller/email are owned by
 * pca-3c3/pca-3c4.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY,
  PROMOTION_EXPIRY_ALERT_WINDOW_DAYS,
  type IPromotionExpiryAlertStateRepository,
  type PromotionExpiryAlertClaim,
} from '../domain/promotion-expiry-alert-state.repository';

/**
 * Engineering-only tick cadence override (no product semantics). Defaults to
 * five minutes: the alert window is seven days, so a tighter cadence only adds
 * no-op reads.
 */
export const PROMOTION_EXPIRY_SCANNER_INTERVAL_MS = Symbol.for(
  'PromotionExpiryScannerIntervalMs',
);

/**
 * Engineering-only per-tick batch cap override (no product semantics). Bounds
 * how many promotions one tick may read and claim.
 */
export const PROMOTION_EXPIRY_SCANNER_BATCH_SIZE = Symbol.for(
  'PromotionExpiryScannerBatchSize',
);

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;

// Tick rate for the `@Interval(...)` decorator. Deliberately shorter than the
// runtime interval so the injectable knob stays honest without spamming the
// database: the real cadence is gated by `lastPollAt` inside `poll()`.
const DECORATOR_TICK_MS = 1000;

/** One due promotion read by the scan query (the claim re-reads it under lock). */
export interface PromotionExpiryCandidate {
  promotionId: string;
  tenantId: string;
}

/** What one bounded tick observed; `failures` counts unsafe claim attempts. */
export interface PromotionExpiryScanSummary {
  scanned: number;
  claimed: number;
  alreadyAlerted: number;
  notEligible: number;
  failures: number;
}

function emptySummary(): PromotionExpiryScanSummary {
  return {
    scanned: 0,
    claimed: 0,
    alreadyAlerted: 0,
    notEligible: 0,
    failures: 0,
  };
}

@Injectable()
export class PromotionExpiryScanner {
  private readonly logger = new Logger(PromotionExpiryScanner.name);
  private lastPollAt = 0;
  private scanning = false;
  /** Rotation cursor: the last id scanned in the previous non-empty tick. */
  private cursorId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROMOTION_EXPIRY_ALERT_STATE_REPOSITORY)
    private readonly repository: IPromotionExpiryAlertStateRepository,
    @Inject(PROMOTION_EXPIRY_SCANNER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(PROMOTION_EXPIRY_SCANNER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  /**
   * Scheduled tick. Throttled by `intervalMs`, never overlaps a tick already in
   * flight, and never rejects — an unhandled rejection inside `@Interval` would
   * silently stop the cadence.
   */
  @Interval(DECORATOR_TICK_MS)
  async poll(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollAt < this.intervalMs) {
      return;
    }
    if (this.scanning) {
      return;
    }
    this.lastPollAt = now;
    this.scanning = true;
    try {
      await this.scan();
    } catch (error) {
      // `scan()` isolates every per-item and read failure; this is the outer
      // fence so a future refactor can never reject out of the tick.
      this.logger.error('[PromotionExpiryScanner] scan threw — tick skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Public seam for the spec: one bounded scan pass. Reads at most `batchSize`
   * candidates, claims each one inside its own try/catch, and advances or wraps
   * the rotation cursor.
   */
  async scan(): Promise<PromotionExpiryScanSummary> {
    const candidates = await this.readBatch();
    if (candidates.length === 0) {
      // End of the rotated range: wrap so the next tick restarts from the first
      // id and no due promotion is starved. Also covers a genuinely empty set.
      this.cursorId = null;
      return emptySummary();
    }

    const summary = emptySummary();
    summary.scanned = candidates.length;

    for (const candidate of candidates) {
      await this.claimCandidate(candidate, summary);
    }

    this.advanceCursor(candidates);
    return summary;
  }

  /**
   * Claims one candidate and folds the typed outcome into `summary`. A claim
   * failure is isolated here so one poison row never aborts the batch nor
   * rejects out of the tick.
   */
  private async claimCandidate(
    candidate: PromotionExpiryCandidate,
    summary: PromotionExpiryScanSummary,
  ): Promise<void> {
    const claim: PromotionExpiryAlertClaim = {
      tenantId: candidate.tenantId,
      promotionId: candidate.promotionId,
    };
    try {
      const result = await this.repository.claimExpiryAlert(claim);
      if (result.outcome === 'claimed') {
        summary.claimed += 1;
      } else if (result.outcome === 'already_alerted') {
        summary.alreadyAlerted += 1;
      } else {
        summary.notEligible += 1;
      }
    } catch (error) {
      // Per-item isolation: one poison row never aborts the batch nor blocks
      // the rest of the due set — the cursor still advances, so a permanently
      // failing row cannot starve the tail.
      summary.failures += 1;
      this.logger.error(
        '[PromotionExpiryScanner] claim threw — skipping promotion to protect the rest of the batch',
        {
          tenantId: candidate.tenantId,
          promotionId: candidate.promotionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Cursor progression: a full batch means the due set may continue beyond it;
   * anything shorter means the rotated range is exhausted and the next tick must
   * wrap. Ids are ordered ascending, so the last element is the high-water mark.
   * A partial failure still advances, which keeps the tail reachable.
   */
  private advanceCursor(candidates: PromotionExpiryCandidate[]): void {
    this.cursorId =
      candidates.length < this.batchSize
        ? null
        : candidates[candidates.length - 1].promotionId;
  }

  /**
   * Bounded, non-locking candidate read. Raw SQL is required for the
   * `NOW()`-relative window and the `id > cursor` rotation predicate; every
   * predicate is tenant-agnostic because the scanner is global, while the claim
   * that follows is tenant-qualified.
   */
  private async readBatch(): Promise<PromotionExpiryCandidate[]> {
    const cursorFilter =
      this.cursorId === null
        ? Prisma.empty
        : Prisma.sql`AND "id" > ${this.cursorId}`;

    // The window is single-sourced from `PROMOTION_EXPIRY_ALERT_WINDOW_DAYS` and
    // bound as a plain number (`(? * INTERVAL '1 day')`) — the same parameterized
    // interval pattern the outbox pollers already use — so the scanner and the
    // claim revalidation can never drift and no value is ever interpolated into
    // the SQL text.
    return this.prisma.$queryRaw<PromotionExpiryCandidate[]>(Prisma.sql`
      SELECT "id" AS "promotionId", "tenantId" AS "tenantId"
        FROM "promotions"
       WHERE "manuallyEnded" = FALSE
         AND "endDate" IS NOT NULL
         AND "endDate" > NOW()
         AND "endDate" <= NOW() + (${PROMOTION_EXPIRY_ALERT_WINDOW_DAYS} * INTERVAL '1 day')
         AND ("startDate" IS NULL OR "startDate" <= NOW())
         ${cursorFilter}
       ORDER BY "id" ASC
       LIMIT ${this.batchSize}
    `);
  }
}
