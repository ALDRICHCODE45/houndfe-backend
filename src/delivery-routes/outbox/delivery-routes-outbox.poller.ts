/**
 * DeliveryRoutesOutboxPoller — delivery-routes / WU3 (design §5, ADR-7).
 *
 * Dedicated claimed-row source for the two delivery-routes outbox types:
 * `delivery.next_stop.notify` (WU3) and `delivery.thank_you.notify`
 * (DTE-5b). Mirrors the `LowStockOutboxPoller` / `HrTimeOffOutboxPoller`
 * claim pattern (`FOR UPDATE SKIP LOCKED` + `lockToken`/`lockedUntil`)
 * with the same two material differences:
 *
 *   1. **Exclusive claim.** The WHERE clause carries an
 *      `AND "eventType" IN ('delivery.next_stop.notify',
 *      'delivery.thank_you.notify')` predicate so this poller claims
 *      ONLY delivery-routes rows — disjoint from the generic poller
 *      (which excludes BOTH types) and from the low-stock /
 *      hr-time-off / promotions pollers. The predicate was widened from
 *      equality to `IN (...)` in the SAME commit that made
 *      `DeliveryRoutesOutboxDispatcher` type-aware, so a thank-you row
 *      is never claimed before its Inngest route is correct.
 *   2. **Dedicated dispatcher hand-off.** Claimed rows are forwarded to
 *      `DeliveryRoutesOutboxDispatcher`, which AWAITS
 *      `InngestService.send(...)` and marks `PUBLISHED` only on
 *      resolve — the durability boundary the generic
 *      `OutboxDispatcherService` (fire-and-forget) cannot satisfy.
 *
 * The per-row try/catch around `dispatcher.dispatch(event)` is the
 * outer fence for any throw that escapes the dispatcher's own
 * try/catch — same pattern as `LowStockOutboxPoller` (R4 fix 1b).
 *
 * Spec: design.md §5 (route check-in durable pipeline).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { DELIVERY_THANK_YOU_OUTBOX_TYPE } from '../inngest/delivery-thank-you.event';
import { DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE } from './delivery-route-outbox.types';
import { DeliveryRoutesOutboxDispatcher } from './delivery-routes-outbox.dispatcher';

export const DELIVERY_ROUTES_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'DeliveryRoutesOutboxPollerIntervalMs',
);
export const DELIVERY_ROUTES_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'DeliveryRoutesOutboxPollerBatchSize',
);
export const DELIVERY_ROUTES_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'DeliveryRoutesOutboxPollerLockMs',
);

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOCK_MS = 60000;

const DECORATOR_TICK_MS = 1000;

@Injectable()
export class DeliveryRoutesOutboxPoller {
  private readonly logger = new Logger(DeliveryRoutesOutboxPoller.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_ROUTES_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(DELIVERY_ROUTES_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(DELIVERY_ROUTES_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number = DEFAULT_LOCK_MS,
    private readonly dispatcher: DeliveryRoutesOutboxDispatcher,
  ) {}

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
        // Outer fence: one throwing row never aborts the batch or
        // rejects out of poll(). The dispatcher's own try/catch handles
        // the common failure modes (Inngest reject).
        this.logger.error(
          '[DeliveryRoutesOutboxPoller] dispatch threw — skipping row to protect the rest of the batch',
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
   * Public seam for the spec — claims PENDING delivery-routes rows
   * (`delivery.next_stop.notify` OR `delivery.thank_you.notify`)
   * exclusively (no overlap with the generic poller or the low-stock /
   * hr-time-off / promotions pollers). `SKIP LOCKED` makes concurrent
   * claims a no-op, not a contention error.
   *
   * The two literals are interpolated from the committed event-type
   * constants so a rename cannot silently drift the predicate away from
   * the types the dispatcher routes.
   */
  async claimBatch(): Promise<DispatchableOutboxEvent[]> {
    const lockToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const pendingRows = (await tx.$queryRawUnsafe<{ id: string }[]>(
        `
          SELECT id
          FROM outbox_events
          WHERE status = 'PENDING'
            AND "nextAttemptAt" <= NOW()
            AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
            AND "eventType" IN ('${DELIVERY_NEXT_STOP_NOTIFY_EVENT_TYPE}', '${DELIVERY_THANK_YOU_OUTBOX_TYPE}')
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
        `[DeliveryRoutesOutboxPoller] claimed ${claimed.length} delivery-routes outbox events`,
      );
      return claimed;
    });
  }
}
