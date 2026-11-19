/**
 * LiveSessionSweepScheduler — the timeouts of the live conversation (unit 11;
 * contract §4.2, §4.6, §12.15): STARTING without ack (60 s) reverts, ENDING
 * without ack (10 min) is marked ENDED, ACTIVE with a silent customer (2 h)
 * ends. Same pattern as the SLA sweep: `@Interval`, bounded batches, SKIP
 * LOCKED inside the store, no in-memory cursor, never overlaps in a process
 * and never rejects out of the interval. Gated in tests by the scheduler gate.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  type DueCursor,
  LiveSessionSweepStore,
  type SessionSweepResult,
} from './live-session-sweep.store';

const LIVE_SESSION_SWEEP_INTERVAL_MS = 10_000;
const MAX_BATCHES_PER_TICK = 5;

@Injectable()
export class LiveSessionSweepScheduler {
  private readonly logger = new Logger(LiveSessionSweepScheduler.name);
  private running = false;

  constructor(private readonly store: LiveSessionSweepStore) {}

  @Interval(LIVE_SESSION_SWEEP_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const total = await this.tick();
      if (
        total.reverted +
          total.ended +
          total.idleEnded +
          total.noticed +
          total.settledDeferred +
          total.failed >
        0
      ) {
        this.logger.log(
          `live session sweep: ${total.reverted} reverted, ${total.ended} ended, ${total.idleEnded} idle-ended, ${total.noticed} noticed, ${total.settledDeferred} deferred settled, ${total.skipped} skipped, ${total.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error('live session sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: the seam of the specs. */
  async tick(now: Date = new Date()): Promise<SessionSweepResult> {
    const total: SessionSweepResult = {
      candidates: 0,
      reverted: 0,
      ended: 0,
      idleEnded: 0,
      noticed: 0,
      settledDeferred: 0,
      skipped: 0,
      failed: 0,
    };
    // Rows are read oldest due first and each page starts after the last row
    // of the previous one (keyset), so rows that are locked, skipped or failing
    // are paged past within the tick instead of being re-read forever or
    // hiding the due rows behind them. The cap bounds the work of one tick; a
    // backlog beyond it continues next tick.
    let after: DueCursor | null = null;
    let capped = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const { last, ...result } = await this.store.runBatch(now, after);
      for (const key of Object.keys(total) as Array<keyof SessionSweepResult>) {
        total[key] += result[key];
      }
      if (result.candidates < this.store.batchSize || last === null) break;
      after = last;
      capped = batch === MAX_BATCHES_PER_TICK - 1;
    }
    if (capped) {
      this.logger.warn(
        `live session sweep: per-tick cap of ${MAX_BATCHES_PER_TICK} batches reached with more due rows; the rest continues next tick`,
      );
    }
    // T11d: the notice phase (customer wrote, 5 and 15 min unanswered).
    const notices = await this.store.runNoticeBatch(now);
    total.noticed += notices.noticed;
    total.failed += notices.failed;
    // S16 3 backstop: deferred staff messages of an epoch that is over.
    const deferred = await this.store.runDeferredBatch();
    total.settledDeferred += deferred.settledDeferred;
    total.failed += deferred.failed;
    return total;
  }
}
