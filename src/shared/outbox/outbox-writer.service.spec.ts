import { OutboxEventStatus } from '@prisma/client';
import { OutboxWriterService } from './outbox-writer.service';

describe('OutboxWriterService', () => {
  it('writes a PENDING outbox row with provided payload and tenant scope', async () => {
    const outboxEventCreate = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prismaClient = {
      outboxEvent: {
        create: outboxEventCreate,
      },
    };
    const service = new OutboxWriterService();

    await service.publish(
      prismaClient as unknown as Parameters<OutboxWriterService['publish']>[0],
      'tenant-1',
      'Sale',
      'sale-1',
      'sale.confirmed',
      { saleId: 'sale-1', totalCents: 1200 },
    );

    expect(outboxEventCreate).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        aggregateType: 'Sale',
        aggregateId: 'sale-1',
        eventType: 'sale.confirmed',
        payload: { saleId: 'sale-1', totalCents: 1200 },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
      },
    });
  });
});
