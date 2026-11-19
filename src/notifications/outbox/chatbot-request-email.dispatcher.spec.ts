import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  ChatbotRequestEmailDispatcher,
  groupJobs,
  idempotencyKey,
} from './chatbot-request-email.dispatcher';

const job = (
  id: string,
  userId: string,
  mode: 'BATCH' | 'IMMEDIATE',
  tenantId = 'tenant-1',
): DispatchableOutboxEvent => ({
  id: `row-${id}`,
  tenantId,
  aggregateType: 'Notification',
  aggregateId: id,
  eventType: 'chatbot_request.email',
  payload: { notificationId: id, userId, mode },
  status: OutboxEventStatus.PENDING,
  retryCount: 0,
  nextAttemptAt: new Date(),
  lastError: null,
  lockToken: 'lock-1',
  lockedUntil: new Date(),
  createdAt: new Date(),
  publishedAt: null,
});

describe('groupJobs', () => {
  it('puts the BATCH jobs of one person in one group', () => {
    const groups = groupJobs([
      job('a', 'u1', 'BATCH'),
      job('b', 'u1', 'BATCH'),
      job('c', 'u2', 'BATCH'),
    ]);
    expect(groups.map((g) => g.map((j) => j.aggregateId))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('keeps IMMEDIATE jobs alone, even for the same person', () => {
    const groups = groupJobs([
      job('a', 'u1', 'IMMEDIATE'),
      job('b', 'u1', 'IMMEDIATE'),
      job('c', 'u1', 'BATCH'),
    ]);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it('never merges the batches of two tenants for the same user id', () => {
    const groups = groupJobs([
      job('a', 'u1', 'BATCH', 't1'),
      job('b', 'u1', 'BATCH', 't2'),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('idempotencyKey', () => {
  const base = {
    tenantId: 't',
    userId: 'u',
    mode: 'BATCH' as const,
    notificationIds: ['a', 'b'],
  };

  it('is stable for the same set and differs for another', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
    expect(idempotencyKey(base)).not.toBe(
      idempotencyKey({ ...base, notificationIds: ['a', 'b', 'c'] }),
    );
  });
});

describe('ChatbotRequestEmailDispatcher.dispatch', () => {
  function setup(sendImpl: jest.Mock) {
    const updateMany = jest
      .fn<
        Promise<{ count: number }>,
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >()
      .mockResolvedValue({ count: 1 });
    const dispatcher = new ChatbotRequestEmailDispatcher(
      { outboxEvent: { updateMany } } as never,
      { send: sendImpl } as never,
      () => new Date('2026-11-11T10:00:00Z'),
      100,
      60_000,
      3,
    );
    return { dispatcher, updateMany };
  }

  it('sends ONE event for a batch group and publishes every row', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['x'] });
    const { dispatcher, updateMany } = setup(send);

    await dispatcher.dispatch([
      job('b', 'u1', 'BATCH'),
      job('a', 'u1', 'BATCH'),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'chatbot-request/email.requested',
      {
        tenantId: 'tenant-1',
        userId: 'u1',
        mode: 'BATCH',
        notificationIds: ['a', 'b'],
      },
      expect.stringMatching(/^chatbot-email:/),
    );
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'row-b',
      lockToken: 'lock-1',
    });
    expect(updateMany.mock.calls[0][0].data.status).toBe('PUBLISHED');
  });

  it('backs off on a rejected send and ends FAILED at maxRetries', async () => {
    const send = jest.fn().mockRejectedValue(new Error('inngest down'));
    const { dispatcher, updateMany } = setup(send);
    const exhausted = { ...job('a', 'u1', 'IMMEDIATE'), retryCount: 2 };

    await dispatcher.dispatch([job('b', 'u1', 'IMMEDIATE')]);
    await dispatcher.dispatch([exhausted]);

    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'PENDING',
      retryCount: 1,
      lastError: 'inngest down',
    });
    expect(updateMany.mock.calls[1][0].data).toMatchObject({
      status: 'FAILED',
      retryCount: 3,
    });
  });
});
