/**
 * RealtimeRetentionScheduler — schedules the 24 h retention purge of the
 * realtime log (contract §5.3, §10.1 R11; unit 8), like the other purges.
 *
 * The purge itself is `PrismaRealtimeEventStore.purgeExpired(now, batch)`: the
 * oldest expired rows, one bounded batch per statement, `FOR UPDATE SKIP
 * LOCKED`, raising the tenant watermark in the same statement. This class only
 * decides WHEN to call it:
 *   - bounded work: at most `maxBatchesPerTick` batches of `batchSize` (1 000)
 *     per tick; a run that hit the cap keeps draining on the next tick;
 *   - several replicas: every replica ticks and `SKIP LOCKED` makes their
 *     batches disjoint; no in-memory cursor (R11);
 *   - no overlap inside one process, and a failure never rejects out of the
 *     `@Interval` (that would stop the cadence silently);
 *   - the clock is injected, so the schedule and the cutoff are testable.
 * Cadence: every 10 minutes (the log is hot and only keeps 24 h, so each purge
 * stays small).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaRealtimeEventStore } from './prisma-realtime-event.store';

export interface RealtimePurgePort {
  purgeExpired(now: Date, batch: number): Promise<number>;
}

export interface RealtimeRetentionOptions {
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerTick?: number;
  clock?: () => Date;
}

export const REALTIME_RETENTION_OPTIONS = Symbol.for(
  'RealtimeRetentionOptions',
);

export interface RealtimePurgeRun {
  removed: number;
  batches: number;
  /** The run stopped at the batch cap while the last batch was still full. */
  hasMore: boolean;
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
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
export class RealtimeRetentionScheduler {
  private readonly logger = new Logger(RealtimeRetentionScheduler.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerTick: number;
  private readonly clock: () => Date;
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private catchingUp = false;
  private running = false;

  constructor(
    @Inject(PrismaRealtimeEventStore)
    private readonly store: RealtimePurgePort,
    @Optional()
    @Inject(REALTIME_RETENTION_OPTIONS)
    options: RealtimeRetentionOptions = {},
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

  /** Runs when the interval elapsed, or at once while a backlog remains. */
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
          `realtime retention purge removed ${run.removed} event(s) in ${run.batches} batch(es)${run.hasMore ? ' (more remain)' : ''}`,
        );
      }
    } catch (error) {
      this.catchingUp = false;
      this.logger.error('realtime retention purge failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: the seam for the specs and for an operator. */
  async purge(): Promise<RealtimePurgeRun> {
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
