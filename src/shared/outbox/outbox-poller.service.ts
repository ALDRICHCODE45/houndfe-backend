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
    @Inject(OUTBOX_POLL_INTERVAL_MS)
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
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
            AND "nextAttemptAt" <= NOW()
            AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
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
          RETURNING id, "tenantId" as "tenantId", "aggregateType" as "aggregateType",
                    "aggregateId" as "aggregateId", "eventType" as "eventType", payload,
                    status, "retryCount" as "retryCount", "nextAttemptAt" as "nextAttemptAt",
                    "lastError" as "lastError", "lockToken" as "lockToken", "lockedUntil" as "lockedUntil",
                    "createdAt" as "createdAt", "publishedAt" as "publishedAt"
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
