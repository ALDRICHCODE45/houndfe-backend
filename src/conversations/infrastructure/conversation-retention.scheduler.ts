/**
 * ConversationRetentionScheduler — schedules the 12-month purge of the
 * conversation mirror (contract §3.6, §10.1 "Purga de 12 meses"; unit 9).
 *
 * The purge owns every retention rule (`ConversationRetentionService`): what is
 * due, the immutability exception, files before rows, failed deletes retried.
 * This class only decides WHEN to call it, exactly like the feed purge of unit
 * 7b:
 *   - bounded work: at most `maxBatchesPerTick` calls (each one batch of 1 000
 *     messages and 100 files) per tick; a run that hit the cap keeps draining on
 *     the next tick, a drained run waits for the interval;
 *   - several replicas: every replica ticks and `SKIP LOCKED` makes their
 *     batches disjoint (no cursor in memory, R11);
 *   - one stamp per run (`runStartedAt`): files that failed in this run wait for
 *     the next one instead of being retried by every batch;
 *   - no overlap in one process, and a failure never rejects out of the
 *     `@Interval` (that would stop the cadence silently);
 *   - the clock is injected.
 *
 * Cadence: the contract speaks of a daily cron (§3.6); hourly keeps each purge
 * small and still satisfies "at least daily". It is the sixteenth `@Interval`
 * of the system (`scheduler-gate.integration.spec.ts`); the S2 media intents and
 * the bucket sweep run inside it, so the count of jobs did not change.
 *
 * Logging: counts only. Never a storage key, a message or a phone.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  CONVERSATION_RETENTION_LIMITS,
  ConversationRetentionService,
  type ConversationRetentionResult,
  type OrphanSweepResult,
} from '../application/conversation-retention.service';

/** The one method of the service the schedule needs. */
export interface ConversationRetentionPort {
  purgeBatch(input?: {
    batchSize?: number;
    mediaBatchSize?: number;
    runStartedAt?: Date;
  }): Promise<ConversationRetentionResult>;
  /** S2: the bucket sweep, once per run (optional: specs may not need it). */
  sweepOrphans?(): Promise<OrphanSweepResult>;
}

/** Engineering-only overrides (no product semantics); all optional. */
export interface ConversationRetentionOptions {
  /** Minimum time between drained runs. Default one hour. */
  intervalMs?: number;
  /** Purge calls per tick. Default 20 (20 000 messages a tick). */
  maxBatchesPerTick?: number;
  clock?: () => Date;
}

export const CONVERSATION_RETENTION_OPTIONS = Symbol.for(
  'ConversationRetentionOptions',
);

export interface ConversationRetentionRun {
  batches: number;
  messagesDeleted: number;
  mediaPurged: number;
  mediaFailed: number;
  conversationsDeleted: number;
  /** S2: media intents settled / failed, and unowned objects the sweep deleted. */
  intentsSettled: number;
  intentsFailed: number;
  orphansDeleted: number;
  /** The run stopped at the cap while the last batch was still full. */
  hasMore: boolean;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_BATCHES = 20;
/** The tick only checks the clock; the real cadence is `intervalMs`. */
const DECORATOR_TICK_MS = 60 * 1000;

@Injectable()
export class ConversationRetentionScheduler {
  private readonly logger = new Logger(ConversationRetentionScheduler.name);
  private readonly intervalMs: number;
  private readonly maxBatchesPerTick: number;
  private readonly clock: () => Date;
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private catchingUp = false;
  private running = false;

  constructor(
    @Inject(ConversationRetentionService)
    private readonly retention: ConversationRetentionPort,
    @Optional()
    @Inject(CONVERSATION_RETENTION_OPTIONS)
    options: ConversationRetentionOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 0) {
      throw new Error('intervalMs must be a non-negative number');
    }
    this.maxBatchesPerTick = options.maxBatchesPerTick ?? DEFAULT_MAX_BATCHES;
    if (
      !Number.isInteger(this.maxBatchesPerTick) ||
      this.maxBatchesPerTick <= 0
    ) {
      throw new Error('maxBatchesPerTick must be a positive integer');
    }
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Scheduled tick. Runs when the interval elapsed since the last run, or at
   * once while the previous run left a backlog. Never overlaps, never rejects.
   */
  @Interval(DECORATOR_TICK_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    const now = this.clock().getTime();
    if (!this.catchingUp && now - this.lastRunAt < this.intervalMs) return;
    this.running = true;
    this.lastRunAt = now;
    try {
      const run = await this.purge();
      this.catchingUp = run.hasMore;
      if (
        run.messagesDeleted > 0 ||
        run.mediaPurged > 0 ||
        run.mediaFailed > 0
      ) {
        this.logger.log(
          `conversation retention: messages=${run.messagesDeleted} files=${run.mediaPurged} failedFiles=${run.mediaFailed} chats=${run.conversationsDeleted} batches=${run.batches}${run.hasMore ? ' (more remain)' : ''}`,
        );
      }
    } catch (error) {
      // Retry at the next interval rather than every tick. The error CLASS
      // only: a message can carry a storage key.
      this.catchingUp = false;
      this.logger.error('conversation retention failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: public seam for the specs and for an operator. */
  async purge(): Promise<ConversationRetentionRun> {
    const runStartedAt = this.clock();
    const run: ConversationRetentionRun = {
      batches: 0,
      messagesDeleted: 0,
      mediaPurged: 0,
      mediaFailed: 0,
      conversationsDeleted: 0,
      intentsSettled: 0,
      intentsFailed: 0,
      orphansDeleted: 0,
      hasMore: false,
    };
    let drained = false;
    while (run.batches < this.maxBatchesPerTick) {
      const result = await this.retention.purgeBatch({
        batchSize: CONVERSATION_RETENTION_LIMITS.messageBatch,
        runStartedAt,
      });
      run.batches += 1;
      run.messagesDeleted += result.messagesDeleted;
      run.mediaPurged += result.mediaPurged;
      run.mediaFailed += result.mediaFailed;
      run.conversationsDeleted += result.conversationsDeleted;
      run.intentsSettled += result.intentsSettled;
      run.intentsFailed += result.intentsFailed;
      if (!result.hasMore) {
        drained = true;
        break;
      }
    }
    run.hasMore = !drained;
    await this.sweepOrphans(run);
    return run;
  }

  /**
   * S2: one bounded page window of the bucket sweep per run. It never fails the
   * run: a storage outage or a lock problem is logged (class only) and retried
   * at the next interval.
   */
  private async sweepOrphans(run: ConversationRetentionRun): Promise<void> {
    if (!this.retention.sweepOrphans) return;
    try {
      const swept = await this.retention.sweepOrphans();
      run.orphansDeleted += swept.deleted;
    } catch (error) {
      this.logger.error('conversation media orphan sweep failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
