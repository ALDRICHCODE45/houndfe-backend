/**
 * ScheduleSweepScheduler — the clock of scheduled conversations (unit 14;
 * contract "Scheduled conversations", §4.9.4, §4.9.6): the reminder 10 minutes
 * before, the staff "solicitud nueva" notice at `scheduledFor`, and the
 * `needsReschedule` backstop. Same pattern as the live session sweep:
 * `@Interval`, bounded keyset-paged batches (due rows only, oldest due first),
 * SKIP LOCKED inside the store, no in-memory cursor, never overlaps in a
 * process and never rejects out of the interval. Gated in tests by the
 * scheduler gate.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  emptyScheduleResult,
  ScheduleSweepStore,
  type ScheduleDueCursor,
  type ScheduleSweepResult,
} from './schedule-sweep.store';

const SCHEDULE_SWEEP_INTERVAL_MS = 15_000;
const MAX_BATCHES_PER_TICK = 5;

@Injectable()
export class ScheduleSweepScheduler {
  private readonly logger = new Logger(ScheduleSweepScheduler.name);
  private running = false;

  constructor(private readonly store: ScheduleSweepStore) {}

  @Interval(SCHEDULE_SWEEP_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const total = await this.tick();
      if (
        total.reminders +
          total.notices +
          total.flagged +
          total.settled +
          total.failed >
        0
      ) {
        this.logger.log(
          `schedule sweep: ${total.reminders} reminders, ${total.notices} notices, ${total.flagged} flagged, ${total.settled} settled, ${total.stale} stale, ${total.skipped} skipped, ${total.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error('schedule sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: the seam of the specs. */
  async tick(now: Date = new Date()): Promise<ScheduleSweepResult> {
    const total = emptyScheduleResult();
    // Oldest due first; each page starts after the last row of the previous
    // one (keyset), so rows that are locked, stale or failing are paged past
    // within the tick instead of hiding the due rows behind them. The cap
    // bounds one tick's work; a backlog beyond it continues next tick.
    let after: ScheduleDueCursor | null = null;
    let capped = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const { last, ...result } = await this.store.runBatch(now, after);
      for (const key of Object.keys(total) as Array<
        keyof ScheduleSweepResult
      >) {
        total[key] += result[key];
      }
      if (result.candidates < this.store.batchSize || last === null) break;
      after = last;
      capped = batch === MAX_BATCHES_PER_TICK - 1;
    }
    if (capped) {
      this.logger.warn(
        `schedule sweep: per-tick cap of ${MAX_BATCHES_PER_TICK} batches reached with more due rows; the rest continues next tick`,
      );
    }
    return total;
  }
}
