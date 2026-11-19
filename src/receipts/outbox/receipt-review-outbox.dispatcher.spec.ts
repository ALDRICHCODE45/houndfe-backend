import { OutboxEventStatus } from '@prisma/client';
import type { InngestService } from '../../inngest/inngest.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { ReceiptReviewOutboxDispatcher } from './receipt-review-outbox.dispatcher';

function claimed(
  overrides: Partial<DispatchableOutboxEvent> = {},
): DispatchableOutboxEvent {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'ReceiptEvidence',
    aggregateId: 'receipt-1',
    eventType: 'receipt.review_requested',
    payload: { tenantId: 'tenant-1', receiptId: 'receipt-1' },
    status: OutboxEventStatus.PENDING,
    retryCount: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    lockToken: 'lock-1',
    lockedUntil: new Date(),
    createdAt: new Date(),
    publishedAt: null,
    ...overrides,
  };
}

type TerminalWrite = {
  where: { id: string; lockToken: string | null };
  data: Record<string, unknown>;
};

function harness(maxRetries = 5) {
  const send = jest.fn().mockResolvedValue({ ids: ['x'] });
  const updateMany = jest
    .fn<Promise<{ count: number }>, [TerminalWrite]>()
    .mockResolvedValue({ count: 1 });
  const dispatcher = new ReceiptReviewOutboxDispatcher(
    { send } as unknown as InngestService,
    { outboxEvent: { updateMany } } as unknown as PrismaService,
    maxRetries,
  );
  const lastWrite = () =>
    updateMany.mock.calls[updateMany.mock.calls.length - 1][0];
  return { dispatcher, send, lastWrite };
}

describe('ReceiptReviewOutboxDispatcher', () => {
  it('awaits the Inngest send with a tenant:receipt idempotency key, then marks PUBLISHED under the lock', async () => {
    const { dispatcher, send, lastWrite } = harness();

    await dispatcher.dispatch(claimed());

    expect(send).toHaveBeenCalledWith(
      'receipts/review.requested',
      { tenantId: 'tenant-1', receiptId: 'receipt-1' },
      'tenant-1:receipt-1',
    );
    expect(lastWrite().where).toEqual({ id: 'evt-1', lockToken: 'lock-1' });
    expect(lastWrite().data).toMatchObject({
      status: OutboxEventStatus.PUBLISHED,
      lockToken: null,
    });
  });

  it('drops a legacy customerName from the Inngest event data (R10)', async () => {
    const { dispatcher, send } = harness();

    await dispatcher.dispatch(
      claimed({
        payload: {
          tenantId: 'tenant-1',
          receiptId: 'receipt-1',
          customerName: 'Irene Domínguez',
        },
      }),
    );

    expect(send).toHaveBeenCalledWith(
      'receipts/review.requested',
      { tenantId: 'tenant-1', receiptId: 'receipt-1' },
      'tenant-1:receipt-1',
    );
  });

  it('keeps the row PENDING with a backoff when the send rejects', async () => {
    const { dispatcher, send, lastWrite } = harness();
    send.mockRejectedValue(new Error('inngest down'));

    await expect(dispatcher.dispatch(claimed())).resolves.toBeUndefined();

    expect(lastWrite().where).toEqual({ id: 'evt-1', lockToken: 'lock-1' });
    expect(lastWrite().data).toMatchObject({
      status: OutboxEventStatus.PENDING,
      retryCount: 1,
      lastError: 'inngest down',
    });
    expect(lastWrite().data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('marks FAILED once the retries are exhausted', async () => {
    const { dispatcher, send, lastWrite } = harness(3);
    send.mockRejectedValue(new Error('still down'));

    await dispatcher.dispatch(claimed({ retryCount: 2 }));

    expect(lastWrite().data).toMatchObject({
      status: OutboxEventStatus.FAILED,
      retryCount: 3,
    });
  });
});
