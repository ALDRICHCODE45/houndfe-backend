/**
 * SaleHoldSweepScheduler — the clock of pay-in-store holds (pay-in-store-pickup
 * / T2; S2, S3, S4): the customer reminder 3 h before the deadline and, at the
 * deadline, the automatic cancellation of an unpaid hold (or a staff notice
 * when something was paid or a receipt is pending). Same pattern as the
 * schedule sweep: `@Interval`, bounded keyset-paged batches (due rows only,
 * oldest deadline first), SKIP LOCKED inside the store, no in-memory cursor,
 * never overlaps in a process and never rejects out of the interval. Gated in
 * tests by the scheduler gate.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  emptyHoldResult,
  SaleHoldSweepStore,
  type HoldDueCursor,
  type HoldSweepResult,
} from './sale-hold-sweep.store';

const HOLD_SWEEP_INTERVAL_MS = 30_000;
const MAX_BATCHES_PER_TICK = 5;

@Injectable()
export class SaleHoldSweepScheduler {
  private readonly logger = new Logger(SaleHoldSweepScheduler.name);
  private running = false;

  constructor(private readonly store: SaleHoldSweepStore) {}

  @Interval(HOLD_SWEEP_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const total = await this.tick();
      // Counts only, and only when something happened.
      if (
        total.reminders +
          total.expired +
          total.reviews +
          total.settled +
          total.failed >
        0
      ) {
        this.logger.log(
          `hold sweep: ${total.reminders} reminders, ${total.expired} expired, ${total.reviews} reviews, ${total.settled} settled, ${total.stale} stale, ${total.skipped} skipped, ${total.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error('hold sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run: the seam of the specs. */
  async tick(now: Date = new Date()): Promise<HoldSweepResult> {
    const total = emptyHoldResult();
    let after: HoldDueCursor | null = null;
    let capped = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const { last, ...result } = await this.store.runBatch(now, after);
      for (const key of Object.keys(total) as Array<keyof HoldSweepResult>) {
        total[key] += result[key];
      }
      if (result.candidates < this.store.batchSize || last === null) break;
      after = last;
      capped = batch === MAX_BATCHES_PER_TICK - 1;
    }
    if (capped) {
      this.logger.warn(
        `hold sweep: per-tick cap of ${MAX_BATCHES_PER_TICK} batches reached with more due rows; the rest continues next tick`,
      );
    }
    return total;
  }
}
