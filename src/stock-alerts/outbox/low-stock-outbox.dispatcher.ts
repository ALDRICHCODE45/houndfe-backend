/**
 * LowStockOutboxDispatcher — Slice F.5 dedicated delivery path
 * for `eventType='stock.low.detected'`.
 *
 * Receives a claimed `OutboxEvent` row from `LowStockOutboxPoller`
 * (F.4), enriches the payload (productName / variantDescription /
 * sku / category / deepLink) inside `runWithTenant`, then
 * **AWAITS** `InngestService.send(...)`.
 *
 * **Why AWAIT (the load-bearing await).** The generic
 * `OutboxDispatcherService` uses `eventEmitter.emit()` which is
 * non-awaitable (`@OnEvent` listeners run detached). A failure
 * from one of those listeners is swallowed with the row already
 * `PUBLISHED` — a latent lost-message bug for ALL consumers of
 * the generic dispatcher. The dedicated path closes it: we own
 * the `InngestService.send` promise here, so a rejection falls
 * into a `try/catch` that bumps `retryCount`, schedules an
 * exponential `nextAttemptAt`, records `lastError`, and leaves
 * the row `PENDING` (or `FAILED` at `maxRetries`).
 *
 * **Replay idempotency.** The idempotency seed
 * `${tenantId}:${productId}:${variantKey}:${alertEpoch}` is
 * passed as Inngest's event `id`, so a poller replay of the
 * SAME row (e.g. a successful send that lost its mark-`PUBLISHED`
 * ack) collapses to ONE event in Inngest — finding #5.
 *
 * **Enrichment.** The outbox payload carries minimal fields
 * (the in-tx enrichment was deferred to this dispatcher per
 * `prisma-product.repository.ts:407-411`). Here we re-read
 * `product.name` / `category.name` / `sku` / variant description
 * + `deepLink` (built from `APP_WEB_URL`) inside
 * `runWithTenant(tenantId, ...)` so tenant scoping is honored.
 *
 * Spec: design.md "Durable dispatch flow (finding #10)" + Slice
 * F.5 task in `tasks.md` + Risk R-E.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { InngestService } from '../../inngest/inngest.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import type { LowStockEventPayload } from '../domain/stock-crossing';

export const LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES = Symbol.for(
  'LowStockOutboxDispatcherMaxRetries',
);

const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2_000;

/**
 * Backoff schedule for `nextAttemptAt` on retry. Index = the
 * `retryCount` value the row will hold AFTER the bump, so we look
 * up `retryCount+1`. A small exponential curve so a flapping
 * downstream (Inngest, Resend) gets breathing room without
 * blocking the queue for long.
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
  // Add ±10% jitter to spread retries across the fleet.
  const jitter = Math.round(base * 0.1 * (Math.random() * 2 - 1));
  return Math.max(BACKOFF_BASE_MS, base + jitter);
}

@Injectable()
export class LowStockOutboxDispatcher {
  private readonly logger = new Logger(LowStockOutboxDispatcher.name);

  constructor(
    private readonly inngestService: InngestService,
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
    @Inject(LOW_STOCK_OUTBOX_DISPATCHER_MAX_RETRIES)
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
  ) {}

  /**
   * Dispatch one claimed outbox row. AWAITS `InngestService.send`
   * and only marks `PUBLISHED` on resolve — the durability
   * boundary that the generic dispatcher's fire-and-forget hop
   * cannot satisfy (Risk R-E).
   *
   * The `event` arg is structurally a `DispatchableOutboxEvent`
   * (the row + payload + lock state); the dispatcher's responsibility
   * is to:
   *
   *   1. Enrich the payload (tenant-scoped read in `runWithTenant`).
   *   2. AWAIT `inngestService.send('stock/low.detected', enriched, seed)`.
   *   3. On resolve → `outboxEvent.update({ ..., status: PUBLISHED, lockToken: null, ... })`.
   *   4. On reject → bump retryCount + lastError + nextAttemptAt;
   *      at `maxRetries` move to `FAILED`.
   */
  async dispatch(event: DispatchableOutboxEvent): Promise<void> {
    const basePayload = event.payload as Partial<LowStockEventPayload>;
    const tenantId = event.tenantId;

    if (!tenantId) {
      this.logger.error(
        '[LowStockOutboxDispatcher] missing tenantId on claim — leaving row PENDING for retry',
        { eventId: event.id, eventType: event.eventType },
      );
      // Fix 5 (Resilience, R4): bump retryCount + honor exhaustion just
      // like the send-failure path. Passing nextRetryCount=0 made the
      // row loop forever — an "infinite poison" with no FAILED exit.
      const nextRetryCount = event.retryCount + 1;
      const isExhausted = nextRetryCount >= this.maxRetries;
      await this.markRetry(
        event,
        nextRetryCount,
        'missing tenantId on claim',
        isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
      );
      return;
    }

    // Fix 1a (Resilience, R4): `enrich()` does a tenant-scoped Prisma
    // read (product.findFirst → variant.findFirst + deepLink compose).
    // ANY throw — DB blip, CLS eviction, Prisma validation — used to
    // escape dispatch() and abort the poller's per-row loop (no
    // per-row try/catch around `await dispatcher.dispatch(event)`).
    // The throwing row never got a retryCount bump, no lastError, no
    // FAILED transition → invisible poison pill re-failing every poll
    // cycle AND up to 24 other claimed rows sat locked for `lockMs`.
    // Move enrich() + the idempotency key inside the durability try so
    // a bad row flows through markRetry (backoff + lastError + FAILED).
    try {
      const idemKey = computeIdempotencyKey(event);
      const enriched = await this.enrich(event);

      await this.inngestService.send('stock/low.detected', enriched, idemKey);
      await this.markPublished(event);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'unknown Inngest send / enrichment error';
      const nextRetryCount = event.retryCount + 1;
      const isExhausted = nextRetryCount >= this.maxRetries;
      await this.markRetry(
        event,
        nextRetryCount,
        message,
        isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
      );

      if (isExhausted) {
        // Prod send-failure alert path: a low-stock alert that
        // exhausted retries is a real incident (customer has no
        // actionable notification). Logged at `error` level +
        // `lastError` stamped on the row for the support runbook.
        this.logger.error(
          '[LowStockOutboxDispatcher] stock.low.detected exhausted retries — manual intervention needed',
          {
            eventId: event.id,
            tenantId,
            retryCount: nextRetryCount,
            lastError: message,
          },
        );
      } else {
        this.logger.warn(
          '[LowStockOutboxDispatcher] send or enrichment rejected — scheduled retry',
          {
            eventId: event.id,
            tenantId,
            retryCount: nextRetryCount,
            nextAttemptDelayMs: nextAttemptDelayMs(nextRetryCount),
            lastError: message,
          },
        );
      }
    }

    void basePayload;
  }

  /**
   * Mark the row PUBLISHED + clear the lock + stamp `publishedAt`.
   * Called ONLY on InngestService.send resolve.
   */
  private async markPublished(event: DispatchableOutboxEvent): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: new Date(),
        retryCount: event.retryCount,
        lastError: null,
        lockToken: null,
        lockedUntil: null,
      },
    });
  }

  /**
   * Mark the row back to PENDING (or FAILED if exhausted) with the
   * bumped retry count and a backed-off `nextAttemptAt`. The lock
   * fields are cleared so the very next poll cycle re-evaluates
   * `lockedUntil <= NOW()`.
   */
  private async markRetry(
    event: DispatchableOutboxEvent,
    nextRetryCount: number,
    message: string,
    status: OutboxEventStatus = OutboxEventStatus.PENDING,
  ): Promise<void> {
    const delayMs = nextAttemptDelayMs(nextRetryCount);
    const nextAttemptAt = new Date(Date.now() + delayMs);

    await this.prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status,
        retryCount: nextRetryCount,
        lastError: message,
        nextAttemptAt,
        lockToken: null,
        lockedUntil: null,
      },
    });
  }

  /**
   * Enrich the outbox payload with the product/variant/category
   * details + deep-link that the in-tx path deliberately deferred.
   * Runs inside `runWithTenant` so `tenantId` is the CLS-seeded
   * scope, honoring tenant isolation. The enrichment read is
   * bounded (single product + single category); worst case is a
   * few milliseconds per crossing.
   *
   * Falls back to the payload's pre-existing (possibly empty)
   * fields when the product/variant is gone (e.g. post-deletion)
   * so the alert still fires with whatever was carried in-tx.
   */
  private async enrich(
    event: DispatchableOutboxEvent,
  ): Promise<LowStockEventPayload> {
    const base = event.payload as Partial<LowStockEventPayload>;
    const tenantId = event.tenantId;

    return this.tenantRunner.runWithTenant(tenantId, async () => {
      const prisma = this.tenantPrisma.getClient();

      const product = await prisma.product.findFirst({
        where: { id: base.productId ?? '' },
        select: {
          name: true,
          sku: true,
          category: { select: { name: true } },
        },
      });

      let variantDescription: string | null = null;
      if (base.variantId) {
        const variant = await prisma.variant.findFirst({
          where: { id: base.variantId },
          select: {
            option: true,
            value: true,
          },
        });
        variantDescription = variant
          ? [variant.option, variant.value].filter(Boolean).join(': ') || null
          : null;
      }

      const appBaseUrl = this.configService.get<string>('APP_WEB_URL') ?? '';
      const deepLink = appBaseUrl
        ? `${appBaseUrl.replace(/\/$/, '')}/products/${base.productId ?? ''}`
        : (base.deepLink ?? '');

      return {
        tenantId,
        productId: base.productId ?? '',
        variantId: base.variantId ?? null,
        variantKey: base.variantKey ?? base.variantId ?? '__PRODUCT__',
        alertEpoch: base.alertEpoch ?? 0,
        newQuantity: base.newQuantity ?? 0,
        minQuantity: base.minQuantity ?? 0,
        productName: product?.name ?? base.productName ?? '(producto)',
        variantDescription,
        sku: product?.sku ?? base.sku ?? null,
        category: product?.category?.name ?? base.category ?? null,
        deepLink,
        occurredAt: base.occurredAt ?? new Date().toISOString(),
        idemKey: computeIdempotencyKey(event),
      } as LowStockEventPayload;
    });
  }
}

/**
 * Idempotency seed: `${tenantId}:${productId}:${variantKey}:${alertEpoch}`.
 * One per distinct crossing episode (the alertEpoch counter is
 * monotonic per flip — see design Decision 2). Replays of the SAME
 * row collapse; a NEW crossing gets a NEW seed ⇒ a new event.
 */
export function computeIdempotencyKey(event: DispatchableOutboxEvent): string {
  const base = event.payload as Partial<LowStockEventPayload>;
  const tenantId = event.tenantId;
  const productId = base.productId ?? '';
  const variantKey = base.variantKey ?? base.variantId ?? '__PRODUCT__';
  const alertEpoch = base.alertEpoch ?? 0;
  return `${tenantId}:${productId}:${variantKey}:${alertEpoch}`;
}

// Keep a deliberate runtime helper to allow the spec to import
// without dragging the full Nest DI graph (only used in tests).
export const _internal = { randomUUID };
void randomUUID;
