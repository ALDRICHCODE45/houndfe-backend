/**
 * LowStockOutboxPoller — Slice F.4 dedicated claimed-row
 * source for `eventType='stock.low.detected'`.
 *
 * Mirrors the generic `OutboxPollerService` claim pattern
 * (`FOR UPDATE SKIP LOCKED` + `lockToken`/`lockedUntil`) but with
 * TWO material differences:
 *
 *   1. **Exclusive claim.** The WHERE clause carries an
 *      `AND "eventType" = 'stock.low.detected'` predicate so
 *      the dedicated poller claims ONLY low-stock alerts — no
 *      overlap with the generic poller (which excludes this
 *      `eventType` after Slice F.3). `SKIP LOCKED` plus the
 *      mutually-exclusive event-type predicates guarantee no
 *      double-processing even if both pollers run concurrently.
 *
 *   2. **Dedicated dispatcher hand-off.** Claimed rows are
 *      forwarded to `LowStockOutboxDispatcher` (Slice F.5),
 *      which **AWAITS** `InngestService.send(...)` and marks
 *      `PUBLISHED` only on resolve — the durability boundary
 *      the generic `OutboxDispatcherService` (fire-and-forget
 *      via `eventEmitter.emit`) cannot satisfy for these rows.
 *
 * Lives on a `@Interval(...)` cron — the interval is injectable
 * via `LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS` so test suites / ops
 * can dampen or speed up the cadence. The `@Interval(5000)` value
 * in the decorator is the live tick-rate; the actual claim happens
 * only when the throttled `poll()` call's elapsed exceeds
 * `intervalMs`.
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice
 * F.4 task in `tasks.md`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { LowStockOutboxDispatcher } from './low-stock-outbox.dispatcher';

export const LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'LowStockOutboxPollerIntervalMs',
);
export const LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'LowStockOutboxPollerBatchSize',
);
export const LOW_STOCK_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'LowStockOutboxPollerLockMs',
);

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOCK_MS = 60000;

// Tick rate for the `@Interval(...)` decorator. Picked deliberately
// to be SHORTER than the runtime interval so a unit-test fast-tick
// never starves; the actual cadence is gated by `lastPollAt` inside
// `poll()`.
const DECORATOR_TICK_MS = 1000;

@Injectable()
export class LowStockOutboxPoller {
  private readonly logger = new Logger(LowStockOutboxPoller.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOW_STOCK_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(LOW_STOCK_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(LOW_STOCK_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number = DEFAULT_LOCK_MS,
    private readonly dispatcher: LowStockOutboxDispatcher,
  ) {}

  /**
   * Scheduled poll entry. Runs every `DECORATOR_TICK_MS` (1s) and
   * short-circuits until `intervalMs` elapsed since the last real
   * claim — so the knob is honest without spamming Prisma.
   *
   * Per-row try/catch around `dispatcher.dispatch(event)`. Without
   * this guard, a single throwing row would:
   *   1) abort the rest of the claimed batch (up to 24 other rows
   *      stay locked for lockMs=60s without a retry bump),
   *   2) reject out of poll() → unhandled rejection inside the
   *      @Interval tick (Nest swallows silently after one log, but
   *      the lock sits until the next tick releases it).
   *
   * With the guard, one bad row logs at error and the rest of the
   * batch proceeds. The dispatcher's own try/catch (F.5) handles
   * the common failure modes (Inngest reject, enrich throw); this
   * outer guard is the belt-and-suspenders for anything that
   * escapes — finding R4 (Resilience review).
   */
  @Interval(DECORATOR_TICK_MS)
  async poll(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollAt < this.intervalMs) {
      return;
    }
    this.lastPollAt = now;

    const events = await this.claimBatch();
    for (const event of events) {
      try {
        await this.dispatcher.dispatch(event);
      } catch (error) {
        // Log + continue. The dispatcher's own try/catch should have
        // absorbed retries/failures; this is the OUTER fence for any
        // throw that escaped (e.g. a defect in a future refactor).
        this.logger.error(
          `[LowStockOutboxPoller] dispatch threw — skipping row to protect the rest of the batch`,
          {
            eventId: event.id,
            tenantId: event.tenantId,
            eventType: event.eventType,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  /**
   * Public seam for F.4 spec — exposes the claim loop directly so
   * tests can verify the SELECT / UPDATE SQL shape and the
   * dispatcher hand-off without driving the cron decorator.
   */
  async claimBatch(): Promise<DispatchableOutboxEvent[]> {
    const lockToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      // Dedicated claim SELECT: ONLY PENDING rows for
      // `stock.low.detected` with no live lock. `SKIP LOCKED` so a
      // concurrent poll (generic OR dedicated) on the same row is
      // a no-op, not a contention error.
      const pendingRows = (await tx.$queryRawUnsafe<{ id: string }[]>(
        `
          SELECT id
          FROM outbox_events
          WHERE status = 'PENDING'
            AND "nextAttemptAt" <= NOW()
            AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
            AND "eventType" = 'stock.low.detected'
          ORDER BY "createdAt" ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        this.batchSize,
      )) as { id: string }[];

      if (pendingRows.length === 0) {
        return [];
      }

      const ids = pendingRows.map((row) => row.id);
      const lockSeconds = this.lockMs / 1000;

      const claimed = await tx.$queryRawUnsafe<DispatchableOutboxEvent[]>(
        `
          UPDATE outbox_events
          SET "lockToken" = $1,
              "lockedUntil" = NOW() + ($2 * INTERVAL '1 second')
          WHERE id = ANY($3::text[])
          RETURNING id, "tenantId" as "tenantId",
                    "aggregateType" as "aggregateType",
                    "aggregateId" as "aggregateId",
                    "eventType" as "eventType", payload,
                    status,
                    "retryCount" as "retryCount",
                    "nextAttemptAt" as "nextAttemptAt",
                    "lastError" as "lastError",
                    "lockToken" as "lockToken",
                    "lockedUntil" as "lockedUntil",
                    "createdAt" as "createdAt",
                    "publishedAt" as "publishedAt"
        `,
        lockToken,
        lockSeconds,
        ids,
      );

      this.logger.debug(
        `[LowStockOutboxPoller] claimed ${claimed.length} stock.low.detected events`,
      );
      return claimed;
    });
  }
}
