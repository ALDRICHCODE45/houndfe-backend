/**
 * BackorderSweepScheduler — the clock of restock backorders (restock-backorder
 * / T2b; contract v1 §4): the reservation reminder 3 h before the end, the
 * expiry 24 h after the reservation, the expired-lot swap and the safety-net
 * allocation. Same pattern as the pay-in-store hold sweep: `@Interval`, bounded
 * keyset-paged batches, SKIP LOCKED inside the store, no in-memory cursor,
 * never overlaps in a process and never rejects out of the interval. Gated in
 * tests by the scheduler gate (specs call `tick(now)` with a fake clock).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BackorderSweepStore,
  emptyBackorderSweepResult,
  type BackorderSweepResult,
  type DueCursor,
  type EtaApplyCursor,
  type EtaCursor,
  type LotCursor,
  type QueueCursor,
} from './backorder-sweep.store';

export type { BackorderSweepResult } from './backorder-sweep.store';

export const BACKORDER_SWEEP_INTERVAL_MS = 30_000;
const MAX_BATCHES_PER_PHASE = 5;

type Phase = 'due' | 'lot' | 'queue' | 'eta' | 'etaApply';

@Injectable()
export class BackorderSweepScheduler {
  private readonly logger = new Logger(BackorderSweepScheduler.name);
  private running = false;

  constructor(private readonly store: BackorderSweepStore) {}

  @Interval(BACKORDER_SWEEP_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const total = await this.tick();
      // Counts only, and only when something happened.
      if (
        total.reminders +
          total.expired +
          total.swapped +
          total.lost +
          total.notHeld +
          total.allocated +
          total.reestimates +
          total.attached +
          total.etaApplied +
          total.failed >
        0
      ) {
        this.logger.log(
          `backorder sweep: ${total.reminders} reminders, ${total.expired} expired, ${total.swapped} lots swapped, ${total.lost} reservations lost, ${total.notHeld} not held, ${total.allocated} allocated, ${total.reestimates} re-estimates requested, ${total.attached} overdue backorders attached, ${total.etaApplied} re-estimates applied, ${total.stale} stale, ${total.skipped} skipped, ${total.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error('backorder sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * One bounded run, the seam of the specs: due timers first (an expiry frees
   * units for the next one), then lots, then the safety-net allocation, then the
   * overdue-ETA re-estimate (T4: ask staff, customer told nothing) and its repair.
   */
  async tick(now: Date = new Date()): Promise<BackorderSweepResult> {
    const total = emptyBackorderSweepResult();
    await this.phase<DueCursor>('due', total, (after) =>
      this.store.runDueBatch(now, after),
    );
    await this.phase<LotCursor>('lot', total, (after) =>
      this.store.runLotBatch(now, after),
    );
    await this.phase<QueueCursor>('queue', total, (after) =>
      this.store.runAllocateBatch(now, after),
    );
    await this.phase<EtaCursor>('eta', total, (after) =>
      this.store.runReestimateBatch(now, after),
    );
    await this.phase<EtaApplyCursor>('etaApply', total, (after) =>
      this.store.runReestimateApplyBatch(now, after),
    );
    return total;
  }

  private async phase<Cursor>(
    name: Phase,
    total: BackorderSweepResult,
    run: (
      after: Cursor | null,
    ) => Promise<BackorderSweepResult & { last: Cursor | null }>,
  ): Promise<void> {
    let after: Cursor | null = null;
    let capped = false;
    for (let batch = 0; batch < MAX_BATCHES_PER_PHASE; batch++) {
      const { last, ...result } = await run(after);
      for (const key of Object.keys(total) as Array<
        keyof BackorderSweepResult
      >) {
        total[key] += result[key];
      }
      if (result.candidates < this.store.batchSize || last === null) break;
      after = last;
      capped = batch === MAX_BATCHES_PER_PHASE - 1;
    }
    if (capped) {
      this.logger.warn(
        `backorder sweep (${name}): per-tick cap of ${MAX_BATCHES_PER_PHASE} batches reached with more candidates; the rest continues next tick`,
      );
    }
  }
}
