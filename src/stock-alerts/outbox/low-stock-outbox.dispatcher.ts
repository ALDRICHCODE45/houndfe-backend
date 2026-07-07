/**
 * LowStockOutboxDispatcher — Slice F.5 placeholder.
 *
 * Receives a claimed `OutboxEvent` row, enriches the payload
 * (productName/variantDescription/sku/category/deepLink), then
 * **AWAITS** `InngestService.send(...)`. The await is load-bearing:
 * a rejected send means the row stays PENDING and the dedicated
 * poller retries it. Marking `PUBLISHED` happens ONLY on resolve.
 *
 * This file is a **placeholder** to allow the module graph to
 * compile before F.5's RED → GREEN. The real implementation +
 * test suite land in the F.5 step (RED first, then GREEN).
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice F.5
 * task in `tasks.md`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InngestService } from '../../inngest/inngest.service';

export const LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES = Symbol.for(
  'LowStockOutboxDispatcherMaxRetries',
);

@Injectable()
export class LowStockOutboxDispatcher {
  private readonly logger = new Logger(LowStockOutboxDispatcher.name);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly inngestService: InngestService,
    @Inject(LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES)
    private readonly maxRetries: number,
  ) {}

  // Real F.5 implementation:
  //   1. read claimed row from outbox_events
  //   2. enrich payload (productName, sku, category, deepLink)
  //   3. AWAIT inngestService.send('stock/low.detected', enriched, idemKey)
  //   4. on resolve → mark PUBLISHED + clear lock
  //   5. on reject → bump retryCount + nextAttemptAt + lastError;
  //      at maxRetries mark FAILED
  //
  // Stub logs once. The F.5 spec drives a real GREEN.
  async dispatch(): Promise<void> {
    this.logger.debug(
      'LowStockOutboxDispatcher stub — F.5 RED → GREEN pending',
    );
  }
}
