/**
 * Dedicated dispatcher of `chatbot_request.email` jobs (unit 6; D5).
 *
 * The notify consumer writes one job per notification; a BATCH job is due at
 * the end of its 2-minute clock window and an IMMEDIATE one right away. This
 * claims what is due (`FOR UPDATE SKIP LOCKED` plus a lease, like the other
 * dedicated pollers) and sends ONE Inngest event per email: every IMMEDIATE
 * job alone, and all the BATCH jobs of one person together. Rows are marked
 * PUBLISHED only after `InngestService.send` resolved; a rejection backs off
 * and ends FAILED at `maxRetries`. Terminal writes compare the lockToken, so a
 * worker whose lease expired never overwrites the new owner. Delivery is
 * at-least-once: the idempotency key is derived from the notification ids, so
 * a replay of the same group is one email.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxEventStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { InngestService } from '../../inngest/inngest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  NOTICE_EMAIL_EVENT_TYPE,
  NOTICE_EMAIL_INNGEST_EVENT,
  type EmailMode,
} from '../domain/chatbot-request-notice';
import { NOTICE_CLOCK } from './chatbot-request-notify.consumer';

export const NOTICE_EMAIL_BATCH_SIZE = Symbol.for('NoticeEmailBatchSize');
export const NOTICE_EMAIL_LOCK_MS = Symbol.for('NoticeEmailLockMs');
export const NOTICE_EMAIL_MAX_RETRIES = Symbol.for('NoticeEmailMaxRetries');

const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 300_000];

export interface NoticeEmailEvent {
  tenantId: string;
  userId: string;
  mode: EmailMode;
  notificationIds: string[];
}

interface EmailJobPayload {
  notificationId: string;
  userId: string;
  mode: EmailMode;
}

@Injectable()
export class ChatbotRequestEmailDispatcher {
  private readonly logger = new Logger(ChatbotRequestEmailDispatcher.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inngest: InngestService,
    @Inject(NOTICE_CLOCK) private readonly now: () => Date,
    @Inject(NOTICE_EMAIL_BATCH_SIZE) private readonly batchSize: number = 100,
    @Inject(NOTICE_EMAIL_LOCK_MS) private readonly lockMs: number = 60_000,
    @Inject(NOTICE_EMAIL_MAX_RETRIES) private readonly maxRetries: number = 5,
  ) {}

  @Interval(2000)
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await this.claimDue();
      for (const group of groupJobs(claimed)) await this.dispatch(group);
    } finally {
      this.running = false;
    }
  }

  /**
   * Public seam for specs: claims the due jobs under a lease. The tagged
   * templates below are Prisma bound parameters, not string interpolation.
   */
  claimDue(): Promise<DispatchableOutboxEvent[]> {
    const lockToken = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_events
        WHERE status = 'PENDING' AND "eventType" = ${NOTICE_EMAIL_EVENT_TYPE}
          AND "nextAttemptAt" <= NOW()
          AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      return tx.$queryRaw<DispatchableOutboxEvent[]>`
        UPDATE outbox_events
        SET "lockToken" = ${lockToken},
            "lockedUntil" = NOW() + (${this.lockMs / 1000} * INTERVAL '1 second')
        WHERE id = ANY(${rows.map((row) => row.id)}::text[])
        RETURNING id, "tenantId", "aggregateType", "aggregateId", "eventType",
                  payload, status, "retryCount", "nextAttemptAt", "lastError",
                  "lockToken", "lockedUntil", "createdAt", "publishedAt"`;
    });
  }

  /** Sends one email for the jobs of a group, then settles every row. */
  async dispatch(group: DispatchableOutboxEvent[]): Promise<void> {
    const first = group[0];
    const payload = jobPayload(first);
    const event: NoticeEmailEvent = {
      tenantId: first.tenantId,
      userId: payload.userId,
      mode: payload.mode,
      notificationIds: group.map((job) => job.aggregateId).sort(),
    };
    try {
      await this.inngest.send(
        NOTICE_EMAIL_INNGEST_EVENT,
        event,
        idempotencyKey(event),
      );
      await this.settle(group, { status: OutboxEventStatus.PUBLISHED });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const job of group) {
        const retryCount = job.retryCount + 1;
        const exhausted = retryCount >= this.maxRetries;
        const delay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length) - 1];
        await this.settle([job], {
          status: exhausted
            ? OutboxEventStatus.FAILED
            : OutboxEventStatus.PENDING,
          retryCount,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(this.now().getTime() + delay),
        });
      }
      this.logger.error(
        `email dispatch rejected (${group.length} job(s), tenant ${first.tenantId})`,
      );
    }
  }

  private async settle(
    group: DispatchableOutboxEvent[],
    data: {
      status: OutboxEventStatus;
      retryCount?: number;
      lastError?: string;
      nextAttemptAt?: Date;
    },
  ): Promise<void> {
    for (const job of group) {
      // lockToken compare-and-swap: a stale worker cannot clobber the owner.
      await this.prisma.outboxEvent.updateMany({
        where: { id: job.id, lockToken: job.lockToken },
        data: {
          ...data,
          ...(data.status === OutboxEventStatus.PUBLISHED
            ? { publishedAt: new Date(), lastError: null }
            : {}),
          lockToken: null,
          lockedUntil: null,
        },
      });
    }
  }
}

/**
 * The job payload is written only by `ChatbotRequestNotifyConsumer`, which
 * always sets these three fields.
 */
function jobPayload(job: DispatchableOutboxEvent): EmailJobPayload {
  // SAFETY: producer-controlled JSON with exactly the EmailJobPayload shape.
  return job.payload as unknown as EmailJobPayload;
}

/** IMMEDIATE jobs go alone; BATCH jobs of one (tenant, person) go together. */
export function groupJobs(
  jobs: DispatchableOutboxEvent[],
): DispatchableOutboxEvent[][] {
  const groups = new Map<string, DispatchableOutboxEvent[]>();
  for (const job of jobs) {
    const { userId, mode } = jobPayload(job);
    const key =
      mode === 'BATCH' ? `${job.tenantId}:${userId}:BATCH` : `solo:${job.id}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups.values()];
}

/** The same set of notifications is the same Inngest event. */
export function idempotencyKey(event: NoticeEmailEvent): string {
  return `chatbot-email:${createHash('sha256')
    .update(
      `${event.tenantId}:${event.userId}:${event.notificationIds.join(',')}`,
    )
    .digest('hex')}`;
}
