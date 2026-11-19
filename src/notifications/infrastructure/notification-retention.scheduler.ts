/**
 * NotificationRetentionScheduler — schedules the 90-day retention of
 * `notifications` (contract §5.2; §10.1 R11; unit 7b).
 *
 * Same shape as the chatbot feed purge schedule: bounded batches (at most
 * `maxBatchesPerTick` of `batchSize`, 1 000 by default), every replica ticks
 * and `FOR UPDATE SKIP LOCKED` in the store keeps their batches disjoint, no
 * in-memory cursor (the only memory is "when did I last run"), no overlap in
 * one process, a failure never rejects out of the `@Interval`, and the clock
 * is injected. A run that hit the cap keeps draining on the next tick; a
 * drained run waits for `intervalMs` (default one hour; the contract's daily
 * cron is satisfied, and each purge stays small).
 *
 * The retention is not configurable: 90 days is the contract's number.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaNotificationRetentionStore } from './prisma-notification-retention.store';

/** §5.2: 90 days. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** The one method of the store the schedule needs. */
export interface NotificationRetentionPort {
  purgeOlderThan(cutoff: Date, batch: number): Promise<number>;
}

/** Engineering-only overrides (no product semantics); all optional. */
export interface NotificationRetentionOptions {
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerTick?: number;
  clock?: () => Date;
}

export const NOTIFICATION_RETENTION_OPTIONS = Symbol.for(
  'NotificationRetentionOptions',
);

export interface NotificationRetentionRun {
  removed: number;
  batches: number;
  /** Stopped at the batch cap while the last batch was still full. */
  hasMore: boolean;
}

const DAY_MS = 86_400_000;
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
export class NotificationRetentionScheduler {
  private readonly logger = new Logger(NotificationRetentionScheduler.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerTick: number;
  private readonly clock: () => Date;
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private catchingUp = false;
  private running = false;

  constructor(
    @Inject(PrismaNotificationRetentionStore)
    private readonly store: NotificationRetentionPort,
    @Optional()
    @Inject(NOTIFICATION_RETENTION_OPTIONS)
    options: NotificationRetentionOptions = {},
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
          `notification retention purge removed ${run.removed} row(s) in ${run.batches} batch(es)${run.hasMore ? ' (more remain)' : ''}`,
        );
      }
    } catch (error) {
      this.catchingUp = false;
      this.logger.error('notification retention purge failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: public seam for the specs and for an operator. */
  async purge(): Promise<NotificationRetentionRun> {
    const cutoff = new Date(
      this.clock().getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS,
    );
    let removed = 0;
    let batches = 0;
    while (batches < this.maxBatchesPerTick) {
      const n = await this.store.purgeOlderThan(cutoff, this.batchSize);
      batches += 1;
      removed += n;
      if (n < this.batchSize) return { removed, batches, hasMore: false };
    }
    return { removed, batches, hasMore: true };
  }
}
