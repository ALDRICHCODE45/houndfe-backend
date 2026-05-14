import { Injectable, Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import type { DispatchableOutboxEvent } from './outbox.types';

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly maxRetries = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async dispatch(event: DispatchableOutboxEvent): Promise<void> {
    try {
      this.eventEmitter.emit(event.eventType, event.payload);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown outbox dispatch error';
      const nextRetryCount = event.retryCount + 1;
      const isExhausted = nextRetryCount >= this.maxRetries;

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          retryCount: nextRetryCount,
          status: isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
          nextAttemptAt: new Date(),
          lastError: message,
          lockToken: null,
          lockedUntil: null,
        },
      });

      this.logger.error('Outbox dispatch failed', {
        eventId: event.id,
        eventType: event.eventType,
        tenantId: event.tenantId,
        retryCount: nextRetryCount,
        status: isExhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
        error: message,
      });
    }
  }
}
