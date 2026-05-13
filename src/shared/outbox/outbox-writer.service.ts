import { Injectable } from '@nestjs/common';
import { OutboxEventStatus, type Prisma } from '@prisma/client';
import type { OutboxPayload } from './outbox.types';

@Injectable()
export class OutboxWriterService {
  async publish(
    tx: Prisma.TransactionClient,
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: OutboxPayload,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId,
        aggregateType,
        aggregateId,
        eventType,
        payload,
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
      },
    });
  }
}
