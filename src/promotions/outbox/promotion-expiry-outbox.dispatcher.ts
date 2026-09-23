/** PromotionExpiryOutboxDispatcher (pca-3c3a) — inert path for
 * `promotion.expiring.detected`; awaits `send`, retries, never re-throws.
 *
 * Mirrors `PromotionCapacityOutboxDispatcher`: the dispatcher is the only
 * writer of terminal row state, and it is deliberately NOT registered in any
 * module yet. `pca-3c3b` adds the dedicated expiry poller plus its exclusion
 * from the generic fire-and-forget poller and provides this class with its
 * max-retry token; until then it is inert and unreachable at runtime.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import { InngestService } from '../../inngest/inngest.service';
import { DomainError } from '../../shared/domain/domain-error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  PROMOTION_EXPIRING_INNGEST_EVENT,
  readPromotionExpiryIdentity,
} from './promotion-expiry-outbox.types';

export const PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES = Symbol.for(
  'PromotionExpiryOutboxDispatcherMaxRetries',
);

/** Stable internal contract error: the row's alert identity is unusable. */
export class PromotionExpiryIdentityError extends DomainError {
  constructor() {
    super(IDENTITY_ERROR_CODE, IDENTITY_ERROR_CODE);
  }
}

const IDENTITY_ERROR_CODE = 'PROMOTION_EXPIRY_INVALID_IDENTITY';

const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2_000;

const BACKOFF_TABLE_MS: readonly number[] = [
  2_000, 5_000, 15_000, 60_000, 300_000,
];

function nextAttemptDelayMs(nextRetryCount: number): number {
  const index = Math.min(nextRetryCount - 1, BACKOFF_TABLE_MS.length - 1);
  const base = BACKOFF_TABLE_MS[Math.max(0, index)] ?? BACKOFF_BASE_MS;
  const jitter = Math.round(base * 0.1 * (Math.random() * 2 - 1));
  return Math.max(BACKOFF_BASE_MS, base + jitter);
}

@Injectable()
export class PromotionExpiryOutboxDispatcher {
  private readonly logger = new Logger(PromotionExpiryOutboxDispatcher.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly prisma: PrismaService,
    @Inject(PROMOTION_EXPIRY_OUTBOX_DISPATCHER_MAX_RETRIES)
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
  ) {}

  async dispatch(event: DispatchableOutboxEvent): Promise<void> {
    try {
      await this.inngestService.send(
        PROMOTION_EXPIRING_INNGEST_EVENT,
        event.payload,
        computeIdempotencyKey(event),
      );
      await this.markPublished(event);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown outbox send error';
      const nextRetryCount = event.retryCount + 1;
      const isExhausted = nextRetryCount >= this.maxRetries;
      const delayMs = await this.markRetry(
        event,
        nextRetryCount,
        message,
        isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
      );
      if (isExhausted) {
        this.logger.error(
          `[PromotionExpiryOutboxDispatcher] ${event.id} exhausted retries (${nextRetryCount}) — manual intervention needed: ${message}`,
        );
      } else {
        this.logger.warn(
          `[PromotionExpiryOutboxDispatcher] ${event.id} scheduled retry (retryCount=${nextRetryCount}, nextAttemptDelayMs=${delayMs}): ${message}`,
        );
      }
    }
  }

  private async markPublished(event: DispatchableOutboxEvent): Promise<void> {
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
    if (count === 0) this.logLockLost(event);
  }

  private async markRetry(
    event: DispatchableOutboxEvent,
    nextRetryCount: number,
    message: string,
    status: OutboxEventStatus = OutboxEventStatus.PENDING,
  ): Promise<number> {
    // Draw the jitter exactly once; the caller logs this same value.
    const delayMs = nextAttemptDelayMs(nextRetryCount);
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, lockToken: event.lockToken },
      data: {
        status,
        retryCount: nextRetryCount,
        lastError: message,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lockToken: null,
        lockedUntil: null,
      },
    });
    if (count === 0) this.logLockLost(event);
    return delayMs;
  }

  private logLockLost(event: DispatchableOutboxEvent): void {
    this.logger.debug(
      '[PromotionExpiryOutboxDispatcher] terminal write skipped — lock lost/expired for row',
      { eventId: event.id, tenantId: event.tenantId },
    );
  }
}

/**
 * Resolve and validate the frozen alert identity BEFORE any send. Throws the
 * stable contract error when the payload shape is invalid/empty or when its
 * tenant/promotion disagree with the row — never a fallback key.
 */
function resolveIdentity(event: DispatchableOutboxEvent) {
  const identity = readPromotionExpiryIdentity(event.payload);
  if (
    !identity ||
    identity.tenantId !== event.tenantId ||
    identity.promotionId !== event.aggregateId
  ) {
    throw new PromotionExpiryIdentityError();
  }
  return identity;
}

/**
 * Fingerprint-scoped idempotency key
 * `${tenantId}:${promotionId}:${endDateFingerprint}` — one alert per promotion
 * per effective end date. `A → B → A` reuses the same A key (deduped) while B
 * keeps its own independently deliverable key.
 */
export function computeIdempotencyKey(event: DispatchableOutboxEvent): string {
  const { tenantId, promotionId, endDateFingerprint } = resolveIdentity(event);
  return `${tenantId}:${promotionId}:${endDateFingerprint}`;
}
