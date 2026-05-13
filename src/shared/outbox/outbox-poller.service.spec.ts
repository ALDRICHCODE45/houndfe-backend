import { OutboxEventStatus } from '@prisma/client';
import { OutboxPollerService } from './outbox-poller.service';

describe('OutboxPollerService', () => {
  it('claims pending rows using FOR UPDATE SKIP LOCKED and dispatches claimed events', async () => {
    const prisma = {
      $transaction: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
    const dispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const claimed = [
      {
        id: 'evt-1',
        tenantId: 'tenant-1',
        aggregateType: 'Sale',
        aggregateId: 'sale-1',
        eventType: 'sale.confirmed',
        payload: { saleId: 'sale-1' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-1',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
    ];

    const txQueryRawUnsafe = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'evt-1' }])
      .mockResolvedValueOnce(claimed);

    prisma.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRawUnsafe: txQueryRawUnsafe,
      };
      return work(tx);
    });

    const service = new OutboxPollerService(prisma as never, dispatcher as never, 1000, 50, 30000);

    await service.poll();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      expect.anything(),
    );

    expect(dispatcher.dispatch).toHaveBeenCalledWith(claimed[0]);
  });
});
