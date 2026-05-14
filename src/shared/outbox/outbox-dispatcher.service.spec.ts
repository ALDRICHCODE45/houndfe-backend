import { OutboxEventStatus } from '@prisma/client';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

describe('OutboxDispatcherService', () => {
  const buildPrisma = () => ({
    outboxEvent: {
      update: jest.fn(),
    },
  });

  const buildEvent = (retryCount = 0) => ({
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'Sale',
    aggregateId: 'sale-1',
    eventType: 'sale.confirmed',
    payload: { saleId: 'sale-1' },
    status: OutboxEventStatus.PENDING,
    retryCount,
    nextAttemptAt: new Date(),
    lastError: null,
    lockToken: 'lock-1',
    lockedUntil: new Date(),
    createdAt: new Date(),
    publishedAt: null,
  });

  it('emits event payload and marks event as PUBLISHED on success', async () => {
    const prisma = buildPrisma();
    const eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    const service = new OutboxDispatcherService(
      prisma as never,
      eventEmitter as unknown as EventEmitter2,
    );

    await service.dispatch(buildEvent());

    expect(eventEmitter.emit).toHaveBeenCalledWith('sale.confirmed', { saleId: 'sale-1' });
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({
          status: OutboxEventStatus.PUBLISHED,
          retryCount: 0,
          lockToken: null,
          lockedUntil: null,
          lastError: null,
        }),
      }),
    );
  });

  it('increments retry count and keeps PENDING when dispatch fails before max retries', async () => {
    const prisma = buildPrisma();
    const eventEmitter = {
      emit: jest.fn(() => {
        throw new Error('broker down');
      }),
    };
    const service = new OutboxDispatcherService(
      prisma as never,
      eventEmitter as unknown as EventEmitter2,
    );

    await service.dispatch(buildEvent(2));

    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retryCount: 3,
          status: OutboxEventStatus.PENDING,
        }),
      }),
    );
  });

  it('marks event as FAILED when dispatch fails at max retries', async () => {
    const prisma = buildPrisma();
    const eventEmitter = {
      emit: jest.fn(() => {
        throw new Error('dead-letter');
      }),
    };
    const service = new OutboxDispatcherService(
      prisma as never,
      eventEmitter as unknown as EventEmitter2,
    );

    await service.dispatch(buildEvent(4));

    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retryCount: 5,
          status: OutboxEventStatus.FAILED,
          lastError: 'dead-letter',
        }),
      }),
    );
  });
});
