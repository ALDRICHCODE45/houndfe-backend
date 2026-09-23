/**
 * PromotionCapacityOutboxPoller — pca-3b3b dedicated claimed-row source
 * for `eventType='promotion.near_capacity.detected'`.
 *
 * Mirrors the `HrTimeOffOutboxPoller` claim pattern
 * (`FOR UPDATE SKIP LOCKED` + per-batch UUID `lockToken`/`lockedUntil`)
 * with the same two material differences:
 *
 *   1. **Exclusive claim.** The WHERE clause carries an
 *      `AND "eventType" = 'promotion.near_capacity.detected'`
 *      predicate so this poller claims ONLY promotion-capacity rows —
 *      disjoint from the generic poller (which excludes this
 *      `eventType`) and from the low-stock / hr-time-off /
 *      delivery-routes pollers.
 *   2. **Dedicated dispatcher hand-off.** Claimed rows are forwarded
 *      to `PromotionCapacityOutboxDispatcher`, which AWAITS
 *      `InngestService.send(...)` and marks `PUBLISHED` only on
 *      resolve — the durability boundary the generic
 *      `OutboxDispatcherService` (fire-and-forget) cannot satisfy.
 *
 * The per-row try/catch around `dispatcher.dispatch(event)` is the
 * outer fence for any throw that escapes the dispatcher's own
 * try/catch — one poison row never aborts the batch nor rejects out of
 * the `@Interval` tick (which would leave the batch leased for
 * `lockMs`).
 *
 * This slice only claims and hand-offs the immutable crossing payload as
 * written by the transactional outbox writer. Recipients, config gating,
 * promotion enrichment, batching, and email belong to `pca-3b4`.
 *
 * Spec: promotion-capacity-alerts task pca-3b3b; `pca-3b1` owns the
 * emitted payload contract (`promotion-capacity-outbox.types.ts`).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { PromotionCapacityOutboxDispatcher } from './promotion-capacity-outbox.dispatcher';
import { PROMOTION_NEAR_CAPACITY_EVENT_TYPE } from './promotion-capacity-outbox.types';

export const PROMOTION_CAPACITY_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'PromotionCapacityOutboxPollerIntervalMs',
);
export const PROMOTION_CAPACITY_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'PromotionCapacityOutboxPollerBatchSize',
);
export const PROMOTION_CAPACITY_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'PromotionCapacityOutboxPollerLockMs',
);

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOCK_MS = 60000;

const DECORATOR_TICK_MS = 1000;

@Injectable()
export class PromotionCapacityOutboxPoller {
  private readonly logger = new Logger(PromotionCapacityOutboxPoller.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROMOTION_CAPACITY_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(PROMOTION_CAPACITY_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(PROMOTION_CAPACITY_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number = DEFAULT_LOCK_MS,
    private readonly dispatcher: PromotionCapacityOutboxDispatcher,
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
        // Awaited on purpose: the dispatcher marks the row PUBLISHED only
        // after the Inngest send resolves, so dispatches stay sequential
        // and durable instead of overlapping fire-and-forget sends.
        await this.dispatcher.dispatch(event);
      } catch (error) {
        // Outer fence: one throwing row never aborts the batch or rejects
        // out of poll(). The dispatcher's own try/catch handles the common
        // failure mode (Inngest reject) and so the row keeps its
        // `nextAttemptAt` retry lease.
        this.logger.error(
          `[PromotionCapacityOutboxPoller] dispatch threw — skipping row to protect the rest of the batch`,
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
   * Public seam for the spec — claims PENDING
   * `promotion.near_capacity.detected` rows exclusively (no overlap with
   * the generic poller or the sibling dedicated pollers). `SKIP LOCKED`
   * makes concurrent claims a no-op, not a contention error.
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
            AND "eventType" = '${PROMOTION_NEAR_CAPACITY_EVENT_TYPE}'
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
        `[PromotionCapacityOutboxPoller] claimed ${claimed.length} promotion.near_capacity.detected events`,
      );
      return claimed;
    });
  }
}
