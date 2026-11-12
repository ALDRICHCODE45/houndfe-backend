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
      if (total.reverted + total.ended + total.idleEnded + total.failed > 0) {
        this.logger.log(
          `live session sweep: ${total.reverted} reverted, ${total.ended} ended, ${total.idleEnded} idle-ended, ${total.failed} failed`,
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
      skipped: 0,
      failed: 0,
    };
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const result = await this.store.runBatch(now);
      for (const key of Object.keys(total) as Array<keyof SessionSweepResult>) {
        total[key] += result[key];
      }
      // Stop on a short batch, or when nothing in it could be done (rows that
      // are locked or not due would otherwise be re-read forever).
      if (
        result.candidates < this.store.batchSize ||
        result.candidates === result.skipped + result.failed
      ) {
        break;
      }
    }
    return total;
  }
}
