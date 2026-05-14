import { Injectable } from '@nestjs/common';
import { OutboxEventStatus, type Prisma } from '@prisma/client';
import type { OutboxPayload } from './outbox.types';

type OutboxCreateClient = {
  outboxEvent: {
    create(args: {
      data: {
        tenantId: string;
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        payload: OutboxPayload;
        status: OutboxEventStatus;
        retryCount: number;
      };
    }): Promise<unknown>;
  };
};

@Injectable()
export class OutboxWriterService {
  async publish(
    tx: Prisma.TransactionClient | OutboxCreateClient,
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
