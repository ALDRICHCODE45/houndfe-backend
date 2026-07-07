/**
 * LowStockOutboxPoller — Slice F.4 placeholder.
 *
 * Implements `@Interval(...)`-based polling of the OUTBOX for
 * `eventType='stock.low.detected'` PENDING rows. Uses
 * `FOR UPDATE SKIP LOCKED` (claimBatch pattern from
 * `OutboxPollerService`) plus the dedicated `eventType` predicate
 * so the two pollers claim DISJOINT row sets — combined with the
 * generic poller's exclusion of `stock.low.detected` (Slice F.3)
 * this guarantees no double-processing.
 *
 * This file is a **placeholder** to allow the module graph to
 * compile before F.4's RED → GREEN. The real implementation +
 * test suite land in the F.4 step (RED first, then GREEN).
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice F.4
 * task in `tasks.md`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

export const LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'LowStockOutboxPollerIntervalMs',
);
export const LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'LowStockOutboxPollerBatchSize',
);
export const LOW_STOCK_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'LowStockOutboxPollerLockMs',
);

@Injectable()
export class LowStockOutboxPoller {
  private readonly logger = new Logger(LowStockOutboxPoller.name);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Inject(LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Inject(LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Inject(LOW_STOCK_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number,
  ) {}

  // Real F.4 implementation runs the claim + dispatch loop. The
  // stub logs once so the constructor path stays side-effect-free
  // before the F.4 spec drives a real GREEN.
  @Interval(5000)
  async poll(): Promise<void> {
    this.logger.debug('LowStockOutboxPoller stub — F.4 RED → GREEN pending');
  }
}
