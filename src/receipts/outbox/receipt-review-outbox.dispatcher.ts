/**
 * ReceiptReviewOutboxDispatcher — durable delivery of
 * `eventType='receipt.review_requested'` (transfer-receipts / T2).
 *
 * Mirrors HrTimeOffOutboxDispatcher: AWAITS `InngestService.send` with the
 * idempotency key `${tenantId}:${receiptId}` and marks PUBLISHED only on
 * resolve; a rejection backs off (FAILED at maxRetries). Terminal writes are
 * lockToken compare-and-swaps, so a worker whose lease expired never
 * overwrites the row's new owner. The payload is self-contained and
 * forwarded verbatim.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import { InngestService } from '../../inngest/inngest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { RECEIPT_REVIEW_REQUESTED_INNGEST_EVENT } from '../domain/receipt-review-requested.event';

export const RECEIPT_REVIEW_OUTBOX_DISPATCHER_MAX_RETRIES = Symbol.for(
  'ReceiptReviewOutboxDispatcherMaxRetries',
);

const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2_000;

const BACKOFF_TABLE_MS: readonly number[] = [
  2_000, // 1 → 2s
  5_000, // 2 → 5s
  15_000, // 3 → 15s
  60_000, // 4 → 1m
  300_000, // 5 → 5m (capped — long-tail)
];

function nextAttemptDelayMs(nextRetryCount: number): number {
  const index = Math.min(nextRetryCount - 1, BACKOFF_TABLE_MS.length - 1);
  const base = BACKOFF_TABLE_MS[Math.max(0, index)] ?? BACKOFF_BASE_MS;
  // ±10% jitter to spread retries across the fleet.
  const jitter = Math.round(base * 0.1 * (Math.random() * 2 - 1));
  return Math.max(BACKOFF_BASE_MS, base + jitter);
}

@Injectable()
export class ReceiptReviewOutboxDispatcher {
  private readonly logger = new Logger(ReceiptReviewOutboxDispatcher.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_REVIEW_OUTBOX_DISPATCHER_MAX_RETRIES)
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
  ) {}

  /**
   * Dispatch one claimed outbox row. AWAITS `InngestService.send` and
   * only marks `PUBLISHED` on resolve. On reject: `markRetry` with
   * backed-off `nextAttemptAt`, bumped `retryCount`, recorded
   * `lastError`; at `maxRetries` the row transitions to `FAILED`.
   *
   * The dispatcher manages the failure state itself — never re-throws
   * the send rejection (the poller's per-row try/catch is the outer
   * guard, mirroring the low-stock pattern).
   */
  async dispatch(event: DispatchableOutboxEvent): Promise<void> {
    const idemKey = computeIdempotencyKey(event);

    try {
      await this.inngestService.send(
        RECEIPT_REVIEW_REQUESTED_INNGEST_EVENT,
        event.payload,
        idemKey,
      );
      await this.markPublished(event);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'unknown receipt review outbox dispatch error';
      const nextRetryCount = event.retryCount + 1;
      const isExhausted = nextRetryCount >= this.maxRetries;
      await this.markRetry(
        event,
        nextRetryCount,
        message,
        isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
      );

      if (isExhausted) {
        this.logger.error(
          '[ReceiptReviewOutboxDispatcher] receipt.review_requested exhausted retries — manual intervention needed',
          {
            eventId: event.id,
            tenantId: event.tenantId,
            retryCount: nextRetryCount,
            lastError: message,
          },
        );
      } else {
        this.logger.warn(
          '[ReceiptReviewOutboxDispatcher] send rejected — scheduled retry',
          {
            eventId: event.id,
            tenantId: event.tenantId,
            retryCount: nextRetryCount,
            nextAttemptDelayMs: nextAttemptDelayMs(nextRetryCount),
            lastError: message,
          },
        );
      }
    }
  }

  private async markPublished(event: DispatchableOutboxEvent): Promise<void> {
    // Compare-and-swap on lockToken: only the worker that STILL owns the
    // lease may finalize the row. If this worker's 60s lease expired and
    // another poll re-claimed the SAME row, the CAS matches ZERO rows
    // (`count === 0`) and we skip — the new owner is authoritative, so a
    // stale terminal write can never clobber its claim/state.
    //
    // `.update()` requires a UNIQUE where and cannot carry the non-unique
    // `lockToken`; `.updateMany()` can, and returns `{ count }`.
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, lockToken: event.lockToken },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: new Date(),
        retryCount: event.retryCount,
        lastError: null,
        lockToken: null,
        lockedUntil: null,
      },
    });

    if (count === 0) {
      this.logger.debug(
        '[ReceiptReviewOutboxDispatcher] terminal write skipped — lock lost/expired for row',
        { eventId: event.id, tenantId: event.tenantId },
      );
    }
  }

  private async markRetry(
    event: DispatchableOutboxEvent,
    nextRetryCount: number,
    message: string,
    status: OutboxEventStatus = OutboxEventStatus.PENDING,
  ): Promise<void> {
    const delayMs = nextAttemptDelayMs(nextRetryCount);
    const nextAttemptAt = new Date(Date.now() + delayMs);

    // Same lockToken compare-and-swap as markPublished: a stale worker
    // whose lease expired must not overwrite the state of the worker
    // that re-claimed the row. `count === 0` ⇒ lock lost ⇒ skip.
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, lockToken: event.lockToken },
      data: {
        status,
        retryCount: nextRetryCount,
        lastError: message,
        nextAttemptAt,
        lockToken: null,
        lockedUntil: null,
      },
    });

    if (count === 0) {
      this.logger.debug(
        '[ReceiptReviewOutboxDispatcher] terminal write skipped — lock lost/expired for row',
        { eventId: event.id, tenantId: event.tenantId },
      );
    }
  }
}

/** `${tenantId}:${receiptId}`: a replay of the same row is one Inngest event. */
export function computeIdempotencyKey(event: DispatchableOutboxEvent): string {
  return `${event.tenantId}:${event.aggregateId}`;
}
