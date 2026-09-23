/**
 * PromotionExpiryOutboxPoller — pca-3c3b dedicated claimed-row source for
 * `eventType='promotion.expiring.detected'`.
 *
 * Mirrors the `PromotionCapacityOutboxPoller` claim pattern
 * (`FOR UPDATE SKIP LOCKED` + per-batch UUID `lockToken`/`lockedUntil`)
 * with the same two material differences:
 *
 *   1. **Exclusive claim.** The WHERE clause carries an
 *      `AND "eventType" = 'promotion.expiring.detected'`
 *      predicate so this poller claims ONLY promotion-expiry rows —
 *      disjoint from the generic poller (which excludes this
 *      `eventType`) and from the low-stock / hr-time-off /
 *      delivery-routes / promotion-near-capacity pollers.
 *   2. **Dedicated dispatcher hand-off.** Claimed rows are forwarded
 *      to `PromotionExpiryOutboxDispatcher`, which AWAITS
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
 * This slice only claims and hand-offs the immutable expiry payload as
 * written by the transactional claim repository. The module that
 * provides this poller stays UNREGISTERED in `AppModule` until
 * `pca-3c4c` activates the whole delivery path (email registrar plus
 * scanner); until then the generic poller's `eventType` exclusion keeps
 * expiry rows safely `PENDING` instead of fire-and-forget publishing
 * them.
 *
 * Spec: promotion-capacity-alerts task pca-3c3b; `pca-3c1a` owns the
 * emitted payload contract (`promotion-expiry-outbox.types.ts`).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { PromotionExpiryOutboxDispatcher } from './promotion-expiry-outbox.dispatcher';
import { PROMOTION_EXPIRING_EVENT_TYPE } from './promotion-expiry-outbox.types';

export const PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'PromotionExpiryOutboxPollerIntervalMs',
);
export const PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'PromotionExpiryOutboxPollerBatchSize',
);
export const PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'PromotionExpiryOutboxPollerLockMs',
);

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOCK_MS = 60000;

const DECORATOR_TICK_MS = 1000;

@Injectable()
export class PromotionExpiryOutboxPoller {
  private readonly logger = new Logger(PromotionExpiryOutboxPoller.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROMOTION_EXPIRY_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(PROMOTION_EXPIRY_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(PROMOTION_EXPIRY_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number = DEFAULT_LOCK_MS,
    private readonly dispatcher: PromotionExpiryOutboxDispatcher,
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
          `[PromotionExpiryOutboxPoller] dispatch threw — skipping row to protect the rest of the batch`,
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
   * `promotion.expiring.detected` rows exclusively (no overlap with the
   * generic poller or the sibling dedicated pollers). `SKIP LOCKED`
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
            AND "eventType" = '${PROMOTION_EXPIRING_EVENT_TYPE}'
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
        `[PromotionExpiryOutboxPoller] claimed ${claimed.length} promotion.expiring.detected events`,
      );
      return claimed;
    });
  }
}
