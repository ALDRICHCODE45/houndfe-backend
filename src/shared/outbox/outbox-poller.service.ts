import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import type { DispatchableOutboxEvent } from './outbox.types';

export const OUTBOX_POLL_INTERVAL_MS = 'OUTBOX_POLL_INTERVAL_MS';
export const OUTBOX_BATCH_SIZE = 'OUTBOX_BATCH_SIZE';
export const OUTBOX_LOCK_MS = 'OUTBOX_LOCK_MS';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LOCK_MS = 30000;

@Injectable()
export class OutboxPollerService {
  private readonly logger = new Logger(OutboxPollerService.name);
  private lastPollAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: OutboxDispatcherService,
    @Inject(OUTBOX_POLL_INTERVAL_MS) private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    @Inject(OUTBOX_BATCH_SIZE) private readonly batchSize = DEFAULT_BATCH_SIZE,
    @Inject(OUTBOX_LOCK_MS) private readonly lockMs = DEFAULT_LOCK_MS,
  ) {}

  @Interval(1000)
  async poll(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollAt < this.pollIntervalMs) {
      return;
    }
    this.lastPollAt = now;

    const events = await this.claimBatch();
    for (const event of events) {
      await this.dispatcher.dispatch(event);
    }
  }

  private async claimBatch(): Promise<DispatchableOutboxEvent[]> {
    const lockToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const pendingRows = (await tx.$queryRawUnsafe<{ id: string }[]>(
        `
          SELECT id
          FROM outbox_events
          WHERE status = 'PENDING'
            AND next_attempt_at <= NOW()
            AND (locked_until IS NULL OR locked_until < NOW())
          ORDER BY created_at ASC
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
          SET lock_token = $1,
              locked_until = NOW() + ($2 * INTERVAL '1 second')
          WHERE id = ANY($3::uuid[])
          RETURNING id, tenant_id as "tenantId", aggregate_type as "aggregateType",
                    aggregate_id as "aggregateId", event_type as "eventType", payload,
                    status, retry_count as "retryCount", next_attempt_at as "nextAttemptAt",
                    last_error as "lastError", lock_token as "lockToken", locked_until as "lockedUntil",
                    created_at as "createdAt", published_at as "publishedAt"
        `,
        lockToken,
        lockSeconds,
        ids,
      );

      this.logger.debug(`Claimed ${claimed.length} outbox events`);
      return claimed;
    });
  }
}
