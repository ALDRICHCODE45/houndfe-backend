/**
 * ReceiptReviewOutboxPoller — dedicated claimer of
 * `eventType='receipt.review_requested'` rows (transfer-receipts / T2).
 *
 * Mirrors HrTimeOffOutboxPoller: `FOR UPDATE SKIP LOCKED` + lockToken/
 * lockedUntil lease, an exclusive `"eventType" = ...` predicate (the generic
 * OutboxPollerService excludes this type), and a per-row try/catch so one
 * throwing dispatch never aborts the batch.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { ReceiptReviewOutboxDispatcher } from './receipt-review-outbox.dispatcher';

export const RECEIPT_REVIEW_OUTBOX_POLLER_INTERVAL_MS = Symbol.for(
  'ReceiptReviewOutboxPollerIntervalMs',
);
export const RECEIPT_REVIEW_OUTBOX_POLLER_BATCH_SIZE = Symbol.for(
  'ReceiptReviewOutboxPollerBatchSize',
);
export const RECEIPT_REVIEW_OUTBOX_POLLER_LOCK_MS = Symbol.for(
  'ReceiptReviewOutboxPollerLockMs',
);

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LOCK_MS = 60000;

const DECORATOR_TICK_MS = 1000;

@Injectable()
export class ReceiptReviewOutboxPoller {
  private readonly logger = new Logger(ReceiptReviewOutboxPoller.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_REVIEW_OUTBOX_POLLER_INTERVAL_MS)
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    @Inject(RECEIPT_REVIEW_OUTBOX_POLLER_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(RECEIPT_REVIEW_OUTBOX_POLLER_LOCK_MS)
    private readonly lockMs: number = DEFAULT_LOCK_MS,
    private readonly dispatcher: ReceiptReviewOutboxDispatcher,
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
        // rejects out of poll(). The dispatcher's own try/catch
        // handles the common failure modes (Inngest reject).
        this.logger.error(
          `[ReceiptReviewOutboxPoller] dispatch threw — skipping row to protect the rest of the batch`,
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
   * Public seam for the spec — claims PENDING `receipt.review_requested`
   * rows exclusively (the generic poller excludes this type). `SKIP LOCKED` makes concurrent claims a no-op,
   * not a contention error.
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
            AND "eventType" = 'receipt.review_requested'
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
        `[ReceiptReviewOutboxPoller] claimed ${claimed.length} receipt.review_requested events`,
      );
      return claimed;
    });
  }
}
