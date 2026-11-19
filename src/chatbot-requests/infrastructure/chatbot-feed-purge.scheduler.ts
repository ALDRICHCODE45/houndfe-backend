/**
 * ChatbotFeedPurgeScheduler — schedules the chatbot feed retention purge
 * (contract §3.3: the feed keeps 30 days; §10.1 R11; unit 7b).
 *
 * The purge itself already exists and owns every retention rule:
 * `PrismaChatbotFeedStore.purgeExpired(now, batch)` deletes the oldest
 * `chatbot_feed_items` older than 30 days (acknowledged or not, as the contract
 * says), one batch at a time with `FOR UPDATE SKIP LOCKED`, and raises
 * `chatbot_feed_retention.purgedThroughCursor` in the same statement so a
 * cursor below it answers `410 CURSOR_EXPIRED`. Requests, their events and
 * their audit are other tables and are never touched (§6.2: kept forever).
 * This class only decides WHEN to call it:
 *
 *   - bounded work: at most `maxBatchesPerTick` batches of `batchSize` (1 000,
 *     the contract's batch) per tick. A run that hit the cap keeps draining on
 *     the next tick; a drained run waits for the interval;
 *   - several replicas: every replica ticks, and `SKIP LOCKED` makes their
 *     batches disjoint, so there is no double delete and no waiting. There is
 *     no in-memory cursor (R11): the only memory is "when did I last run";
 *   - no overlap inside one process, and a failure never rejects out of the
 *     `@Interval` (that would stop the cadence silently);
 *   - the clock is injected, so the schedule and the cutoff are testable.
 *
 * Cadence: the contract speaks of a daily cron (§3.6, §5.2). Running hourly
 * (one cheap `(createdAt)`-indexed probe) keeps each purge small and still
 * satisfies "at least daily".
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CHATBOT_FEED_STORE } from '../application/chatbot-feed.service';

/** The one method of the feed store the schedule needs. */
export interface ChatbotFeedPurgePort {
  purgeExpired(now: Date, batch: number): Promise<number>;
}

/** Engineering-only overrides (no product semantics); all optional. */
export interface ChatbotFeedPurgeOptions {
  /** Minimum time between drained runs. Default one hour. */
  intervalMs?: number;
  /** Rows per batch. Default 1 000 (contract performance row). */
  batchSize?: number;
  /** Batches per tick. Default 20 (20 000 rows a tick). */
  maxBatchesPerTick?: number;
  clock?: () => Date;
}

export const CHATBOT_FEED_PURGE_OPTIONS = Symbol.for('ChatbotFeedPurgeOptions');

export interface ChatbotFeedPurgeRun {
  removed: number;
  batches: number;
  /** The run stopped at the batch cap while the last batch was still full. */
  hasMore: boolean;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 20;
/** The tick only checks the clock; the real cadence is `intervalMs`. */
const DECORATOR_TICK_MS = 60 * 1000;

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

@Injectable()
export class ChatbotFeedPurgeScheduler {
  private readonly logger = new Logger(ChatbotFeedPurgeScheduler.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerTick: number;
  private readonly clock: () => Date;
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private catchingUp = false;
  private running = false;

  constructor(
    // The module provides the Prisma feed store under this token.
    @Inject(CHATBOT_FEED_STORE) private readonly store: ChatbotFeedPurgePort,
    @Optional()
    @Inject(CHATBOT_FEED_PURGE_OPTIONS)
    options: ChatbotFeedPurgeOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 0) {
      throw new Error('intervalMs must be a non-negative number');
    }
    this.batchSize = positiveInt(
      'batchSize',
      options.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    this.maxBatchesPerTick = positiveInt(
      'maxBatchesPerTick',
      options.maxBatchesPerTick ?? DEFAULT_MAX_BATCHES,
    );
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
      if (run.removed > 0) {
        this.logger.log(
          `feed retention purge removed ${run.removed} item(s) in ${run.batches} batch(es)${run.hasMore ? ' (more remain)' : ''}`,
        );
      }
    } catch (error) {
      // Retry at the next interval rather than every tick.
      this.catchingUp = false;
      this.logger.error('feed retention purge failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: public seam for the specs and for an operator. */
  async purge(): Promise<ChatbotFeedPurgeRun> {
    const now = this.clock();
    let removed = 0;
    let batches = 0;
    while (batches < this.maxBatchesPerTick) {
      const n = await this.store.purgeExpired(now, this.batchSize);
      batches += 1;
      removed += n;
      if (n < this.batchSize) return { removed, batches, hasMore: false };
    }
    return { removed, batches, hasMore: true };
  }
}
