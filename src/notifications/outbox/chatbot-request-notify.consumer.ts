/**
 * Dedicated consumer of `chatbot_request.notify` rows (unit 6; contract §5.1).
 *
 * Each row is processed in ONE local transaction (no external call inside):
 * claim the row (`FOR UPDATE SKIP LOCKED`, so replicas never share one),
 * resolve its recipients from permissions, insert the in-app notifications
 * (idempotent per `dedupKey`), insert one email job per person whose
 * preference allows it, call the realtime hook, and mark the row PUBLISHED.
 * A crash rolls everything back and the row stays PENDING, so there is no
 * lease and no half-done notice. A row that keeps failing backs off and ends
 * FAILED (visible to an administrator) without blocking the rest.
 *
 * It never reads `NotificationSettings` (R8): a tenant without it still gets
 * request notices.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxEventStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  NOTICE_EMAIL_EVENT_TYPE,
  NOTICE_NOTIFY_EVENT_TYPE,
  NOTICE_TYPES,
  batchWindowEnd,
  emailModeOf,
  type ChatbotRequestNotice,
  type NoticePayload,
} from '../domain/chatbot-request-notice';
import {
  NOTIFICATION_EVENTS,
  type NotificationEventsPort,
} from '../domain/notification-events.port';
import {
  emailDisabledAmong,
  resolveRecipientIds,
} from '../infrastructure/notice-recipients';

export const NOTICE_NOTIFY_BATCH_SIZE = Symbol.for('NoticeNotifyBatchSize');
export const NOTICE_NOTIFY_MAX_RETRIES = Symbol.for('NoticeNotifyMaxRetries');
export const NOTICE_CLOCK = Symbol.for('NoticeClock');

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_RETRIES = 5;
/** Backoff per failed attempt (1-based), capped at the last entry. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 300_000];

interface NotifyRow {
  id: string;
  tenantId: string;
  payload: unknown;
  retryCount: number;
}

/** Carries the row id out of a rolled-back transaction. */
class RowFailure extends Error {
  constructor(
    readonly row: NotifyRow,
    readonly reason: unknown,
  ) {
    super('notify row failed');
  }
}

@Injectable()
export class ChatbotRequestNotifyConsumer {
  private readonly logger = new Logger(ChatbotRequestNotifyConsumer.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_EVENTS)
    private readonly events: NotificationEventsPort,
    @Inject(NOTICE_CLOCK) private readonly now: () => Date,
    @Inject(NOTICE_NOTIFY_BATCH_SIZE)
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
    @Inject(NOTICE_NOTIFY_MAX_RETRIES)
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
  ) {}

  /** In-app notices should feel live, so this ticks every second. */
  @Interval(1000)
  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let handled = 0;
      while (handled < this.batchSize && (await this.processOne())) handled++;
      return handled;
    } finally {
      this.running = false;
    }
  }

  /** Processes the oldest due row; `false` when there is none. */
  async processOne(): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<NotifyRow[]>`
          SELECT id, "tenantId", payload, "retryCount"
          FROM outbox_events
          WHERE status = 'PENDING' AND "eventType" = ${NOTICE_NOTIFY_EVENT_TYPE}
            AND "nextAttemptAt" <= NOW()
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        if (!row) return false;
        try {
          await this.apply(tx, row);
        } catch (error) {
          throw new RowFailure(row, error);
        }
        return true;
      });
    } catch (error) {
      if (!(error instanceof RowFailure)) throw error;
      await this.markFailed(error.row, error.reason);
      return true;
    }
  }

  private async apply(tx: Prisma.TransactionClient, row: NotifyRow) {
    const notice = parseNotice(row.payload);
    const recipients = await resolveRecipientIds(tx, row.tenantId, notice);
    if (recipients.length > 0) {
      const payload: NoticePayload = {
        folio: notice.folio,
        subtype: notice.subtype,
        ...(notice.cause ? { cause: notice.cause } : {}),
      };
      // `skipDuplicates` is ON CONFLICT DO NOTHING on (tenant, user, dedupKey):
      // only rows inserted now are returned, so a re-run never mails twice.
      const created = await tx.notification.createManyAndReturn({
        data: recipients.map((userId) => ({
          tenantId: row.tenantId,
          userId,
          type: notice.type,
          requestId: notice.requestId,
          // SAFETY: NoticePayload holds only numbers and strings.
          payload: payload as unknown as Prisma.InputJsonObject,
          dedupKey: notice.dedupKey,
        })),
        skipDuplicates: true,
        select: { id: true, userId: true, type: true, requestId: true },
      });
      await this.enqueueEmails(tx, row.tenantId, notice, created);
      for (const item of created) {
        await this.events.publishCreated(tx, {
          tenantId: row.tenantId,
          userId: item.userId,
          notificationId: item.id,
          type: item.type,
          requestId: item.requestId,
        });
      }
    }
    await tx.outboxEvent.update({
      where: { id: row.id },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: new Date(),
        lastError: null,
      },
    });
  }

  /** One job per notification of a person who did not turn email off. */
  private async enqueueEmails(
    tx: Prisma.TransactionClient,
    tenantId: string,
    notice: ChatbotRequestNotice,
    created: { id: string; userId: string }[],
  ): Promise<void> {
    const mode = emailModeOf(notice.type, notice.subtype);
    if (mode === 'NONE' || created.length === 0) return;
    const off = await emailDisabledAmong(
      tx,
      created.map((item) => item.userId),
    );
    const dueAt = mode === 'BATCH' ? batchWindowEnd(this.now()) : this.now();
    const jobs = created.filter((item) => !off.has(item.userId));
    if (jobs.length === 0) return;
    await tx.outboxEvent.createMany({
      data: jobs.map((item) => ({
        tenantId,
        aggregateType: 'Notification',
        aggregateId: item.id,
        eventType: NOTICE_EMAIL_EVENT_TYPE,
        payload: { notificationId: item.id, userId: item.userId, mode },
        nextAttemptAt: dueAt,
      })),
    });
  }

  /** Backoff or FAILED, outside the rolled-back transaction. */
  private async markFailed(row: NotifyRow, reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason);
    const retryCount = row.retryCount + 1;
    const exhausted = retryCount >= this.maxRetries;
    const delay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length) - 1];
    // Guarded on PENDING: another replica may have finished the row meanwhile.
    await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, status: OutboxEventStatus.PENDING },
      data: {
        status: exhausted
          ? OutboxEventStatus.FAILED
          : OutboxEventStatus.PENDING,
        retryCount,
        lastError: message.slice(0, 500),
        nextAttemptAt: new Date(this.now().getTime() + delay),
      },
    });
    // Ids only: a notice never carries customer data, and neither does a log.
    this.logger.error(
      `notify row ${exhausted ? 'FAILED' : 'will retry'} (${row.id}, tenant ${row.tenantId}, attempt ${retryCount})`,
    );
  }
}

/** The row is written by our producer; anything else is a poison row. */
function parseNotice(payload: unknown): ChatbotRequestNotice {
  const notice = payload as Partial<ChatbotRequestNotice> | null;
  if (
    !notice ||
    !NOTICE_TYPES.includes(notice.type as never) ||
    typeof notice.requestId !== 'string' ||
    typeof notice.folio !== 'number' ||
    typeof notice.subtype !== 'string' ||
    typeof notice.dedupKey !== 'string'
  ) {
    throw new Error('malformed chatbot_request.notify payload');
  }
  return notice as ChatbotRequestNotice;
}
