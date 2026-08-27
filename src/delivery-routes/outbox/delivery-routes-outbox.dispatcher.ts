/**
 * DeliveryRoutesOutboxDispatcher — delivery-routes / WU3 (design §5).
 *
 * Receives a claimed `OutboxEvent` row from
 * `DeliveryRoutesOutboxPoller` and **AWAITS**
 * `InngestService.send('delivery/next-stop.notify', payload, idem)`
 * with the idempotency key `${tenantId}:${currentStopId}` (design §8.4).
 *
 * **Why AWAIT.** The generic `OutboxDispatcherService` uses
 * `eventEmitter.emit()` which is non-awaitable; a rejected listener
 * would be swallowed with the row already `PUBLISHED`. The dedicated
 * path closes that bug for delivery-routes rows: we own the send
 * promise, so a rejection falls into `markRetry` (retryCount bump +
 * backoff + lastError + row stays PENDING or transitions to FAILED at
 * maxRetries).
 *
 * **No enrichment.** The outbox payload is self-contained at write
 * time — `checkInStop` already loaded the customer name and stamped
 * the address label, and the idempotency seed is computed from
 * `tenantId + currentStopId`. The dispatcher forwards `event.payload`
 * verbatim to Inngest. The Inngest function re-resolves the
 * authoritative email via `ISaleCustomerEmailLookup` at send time, so
 * a tenant-scoped Prisma re-read is unnecessary here.
 *
 * **Replay idempotency.** A poller replay of the SAME row collapses to
 * ONE Inngest event via the `idempotencyKey` field on the payload
 * (passed as the Inngest `id`). A second check-in on a DIFFERENT stop
 * ⇒ different `currentStopId` ⇒ different idem ⇒ a new Inngest event.
 *
 * Spec: design.md §5 (route check-in durable pipeline) + §8.4 (outbox
 * event payload).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import { InngestService } from '../../inngest/inngest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';

export const DELIVERY_ROUTES_OUTBOX_DISPATCHER_MAX_RETRIES = Symbol.for(
  'DeliveryRoutesOutboxDispatcherMaxRetries',
);

const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2_000;

/**
 * Backoff schedule for `nextAttemptAt` on retry. Index = the
 * `retryCount` value the row will hold AFTER the bump, so we look up
 * `retryCount+1`. Same shape as the low-stock / hr-time-off dispatchers.
 */
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
export class DeliveryRoutesOutboxDispatcher {
  private readonly logger = new Logger(DeliveryRoutesOutboxDispatcher.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_ROUTES_OUTBOX_DISPATCHER_MAX_RETRIES)
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
   * guard, mirroring the low-stock / hr-time-off pattern).
   */
  async dispatch(event: DispatchableOutboxEvent): Promise<void> {
    const idemKey = computeDeliveryIdempotencyKey(event);

    try {
      await this.inngestService.send(
        'delivery/next-stop.notify',
        event.payload,
        idemKey,
      );
      await this.markPublished(event);
      this.logger.log(
        '[DeliveryRoutesOutboxDispatcher] outbox.event.delivered',
        {
          eventId: event.id,
          tenantId: event.tenantId,
          eventType: event.eventType,
          idempotencyKey: idemKey,
        },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'unknown delivery-routes outbox dispatch error';
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
          '[DeliveryRoutesOutboxDispatcher] delivery.next_stop.notify exhausted retries — manual intervention needed',
          {
            eventId: event.id,
            tenantId: event.tenantId,
            retryCount: nextRetryCount,
            lastError: message,
          },
        );
      } else {
        this.logger.warn(
          '[DeliveryRoutesOutboxDispatcher] outbox.event.failed — scheduled retry',
          {
            eventId: event.id,
            tenantId: event.tenantId,
            eventType: event.eventType,
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
    // lease may finalize the row. If this worker's lease expired and
    // another poll re-claimed the SAME row, the CAS matches ZERO rows
    // (`count === 0`) and we skip — the new owner is authoritative.
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
        '[DeliveryRoutesOutboxDispatcher] terminal write skipped — lock lost/expired for row',
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
        '[DeliveryRoutesOutboxDispatcher] terminal write skipped — lock lost/expired for row',
        { eventId: event.id, tenantId: event.tenantId },
      );
    }
  }
}

/**
 * Idempotency seed for delivery-routes outbox rows:
 * `${tenantId}:${currentStopId}`.
 *
 * The `currentStopId` is encoded inside `event.payload` (set at write
 * time by `DeliveryRoutesService.checkInStop`). We extract it from the
 * payload verbatim — the dispatcher trusts the payload shape because
 * the writer is the same service and the schema is enforced by the TS
 * type. If the payload is malformed (missing `currentStopId`), the
 * dispatcher falls back to the row's `aggregateId` (= routeId), which
 * keeps the call non-throwing but loses per-stop idempotency. The
 * WU3 spec pins the payload shape.
 */
export function computeDeliveryIdempotencyKey(
  event: DispatchableOutboxEvent,
): string {
  const payload = (event.payload ?? {}) as {
    tenantId?: unknown;
    currentStopId?: unknown;
    idempotencyKey?: unknown;
  };
  if (
    typeof payload.idempotencyKey === 'string' &&
    payload.idempotencyKey.length > 0
  ) {
    return payload.idempotencyKey;
  }
  if (
    typeof payload.tenantId === 'string' &&
    typeof payload.currentStopId === 'string'
  ) {
    return `${payload.tenantId}:${payload.currentStopId}`;
  }
  return `${event.tenantId}:${event.aggregateId}`;
}
