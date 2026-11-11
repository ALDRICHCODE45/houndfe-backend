/**
 * ChatbotSlaSweepScheduler — runs the SLA sweep every 30 s (contract §5.4,
 * §10.1 R11; unit 7c). The decisions and writes live in
 * `ChatbotSlaSweepStore`; this class only decides WHEN to call it:
 *
 *   - bounded work: per tick, the `due` phase then the `stale` phase, each at
 *     most `maxBatchesPerTick` batches of 100 rows. A phase that filled its
 *     last batch keeps draining on the next tick;
 *   - several replicas: every replica ticks and `SKIP LOCKED` makes their
 *     batches disjoint, so nothing is processed or notified twice and nobody
 *     waits. No in-memory cursor: the only memory is "is a tick running here";
 *   - a batch that throws stops only its own phase for this tick;
 *   - never overlaps in one process and never rejects out of the `@Interval`
 *     (that would silently stop the cadence); a failed batch is logged and the
 *     next tick retries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ChatbotSlaSweepStore,
  type SweepBatchResult,
  type SweepPhase,
} from './chatbot-sla-sweep.store';

const SLA_SWEEP_INTERVAL_MS = 30_000;
const MAX_BATCHES_PER_TICK = 10;

export interface SweepTickSummary {
  rows: number;
  milestones: number;
  notices: number;
  feedItems: number;
  recomputed: number;
  failed: number;
  groupsFailed: number;
  /** Batches that threw (the phase stopped, the other phase still ran). */
  batchErrors: number;
  /** A phase stopped at the cap with a full last batch. */
  hasMore: boolean;
}

@Injectable()
export class ChatbotSlaSweepScheduler {
  private readonly logger = new Logger(ChatbotSlaSweepScheduler.name);
  private running = false;

  constructor(private readonly store: ChatbotSlaSweepStore) {}

  @Interval(SLA_SWEEP_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.tick();
      if (
        summary.milestones > 0 ||
        summary.recomputed > 0 ||
        summary.failed > 0 ||
        summary.groupsFailed > 0
      ) {
        this.logger.log(
          `sla sweep: ${summary.rows} row(s), ${summary.milestones} milestone(s), ${summary.notices} notice(s), ${summary.feedItems} feed item(s), ${summary.recomputed} recomputed, ${summary.failed} failed, ${summary.groupsFailed} group(s) failed${summary.hasMore ? ' (more remain)' : ''}`,
        );
      }
    } catch (error) {
      this.logger.error('sla sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One bounded run of both phases: the seam of the specs. */
  async tick(): Promise<SweepTickSummary> {
    const summary: SweepTickSummary = {
      rows: 0,
      milestones: 0,
      notices: 0,
      feedItems: 0,
      recomputed: 0,
      failed: 0,
      groupsFailed: 0,
      batchErrors: 0,
      hasMore: false,
    };
    for (const phase of ['due', 'stale'] as SweepPhase[]) {
      for (let batches = 0; ; batches++) {
        if (batches === MAX_BATCHES_PER_TICK) {
          summary.hasMore = true;
          break;
        }
        let result: SweepBatchResult;
        try {
          result = await this.store.runBatch(phase);
        } catch (error) {
          // A batch that cannot run (database trouble) stops its own phase but
          // never the other one; one line per phase per tick.
          summary.batchErrors += 1;
          this.logger.error(`sla sweep ${phase} batch failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        summary.rows += result.rows;
        summary.milestones += result.milestones;
        summary.notices += result.notices;
        summary.feedItems += result.feedItems;
        summary.recomputed += result.recomputed;
        summary.failed += result.failed;
        summary.groupsFailed += result.groupsFailed;
        if (result.rows < this.store.batchSize) break;
      }
    }
    return summary;
  }
}
