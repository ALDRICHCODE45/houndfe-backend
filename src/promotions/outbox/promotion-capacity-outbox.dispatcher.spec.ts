import { Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import { PromotionCapacityOutboxDispatcher } from './promotion-capacity-outbox.dispatcher';
const PAYLOAD = {
  tenantId: 'tenant-1',
  promotionId: 'promotion-1',
  saleId: 'sale-1',
  previousConsumedProductUnits: 79,
  consumedProductUnits: 80,
  maxProductUnits: 100,
  occurredAt: '2026-07-01T00:00:00.000Z',
};
interface UpdateManyCall {
  where: { id: string; lockToken: string | null };
  data: Record<string, unknown> & { status: OutboxEventStatus };
}
function buildClaimed(overrides: Partial<DispatchableOutboxEvent> = {}) {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    aggregateType: 'Promotion',
    aggregateId: 'promotion-1',
    eventType: 'promotion.near_capacity.detected',
    payload: { ...PAYLOAD },
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
function buildDispatcher(
  send: jest.Mock,
  updateMany: jest.Mock,
  maxRetries = 5,
): PromotionCapacityOutboxDispatcher {
  return new PromotionCapacityOutboxDispatcher(
    { send } as never,
    { outboxEvent: { updateMany } } as never,
    maxRetries,
  );
}
function callArgs(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}
describe('PromotionCapacityOutboxDispatcher (pca-3b3a)', () => {
  it('sends the contract name, the verbatim payload, and the ledger-scoped key', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const claimed = buildClaimed();
    await buildDispatcher(
      send,
      jest.fn().mockResolvedValue({ count: 1 }),
    ).dispatch(claimed);
    const call = callArgs(send)[0];
    expect(call[0]).toBe('promotion/near-capacity.detected');
    expect(call[1]).toBe(claimed.payload);
    expect(call[2]).toBe('tenant-1:promotion-1:sale-1');
  });
  it('keeps the SAME key for a same-sale retry and a DISTINCT key for another sale at the same counter value', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const dispatcher = buildDispatcher(
      send,
      jest.fn().mockResolvedValue({ count: 1 }),
    );
    const row = buildClaimed();
    await dispatcher.dispatch(row);
    await dispatcher.dispatch({ ...row, retryCount: 1 });
    await dispatcher.dispatch(
      buildClaimed({ payload: { ...PAYLOAD, saleId: 'sale-2' } }),
    );
    expect(callArgs(send).map((c) => c[2])).toEqual([
      'tenant-1:promotion-1:sale-1',
      'tenant-1:promotion-1:sale-1',
      'tenant-1:promotion-1:sale-2',
    ]);
  });
  it('never sends a fallback key: malformed or mismatched identity cannot reach send and schedules retry', async () => {
    const overrides: Array<Partial<typeof PAYLOAD>> = [
      { saleId: '' },
      { tenantId: '' },
      { promotionId: '' },
      { tenantId: 'foreign-tenant' },
      { promotionId: 'other-promotion' },
    ];
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const dispatcher = buildDispatcher(send, updateMany);
    for (const override of overrides) {
      updateMany.mockClear();
      await expect(
        dispatcher.dispatch(
          buildClaimed({ payload: { ...PAYLOAD, ...override } }),
        ),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
      expect(arg.data.status).toBe(OutboxEventStatus.PENDING);
      expect(arg.data.retryCount).toBe(1);
      expect(arg.data.lastError).toMatch(/PROMOTION_CAPACITY_INVALID_IDENTITY/);
    }
  });
  it('AWAITS send before marking PUBLISHED (deferred send)', async () => {
    let resolveSend: ((value: { ids: string[] }) => void) | undefined;
    const send = jest.fn(
      () =>
        new Promise<{ ids: string[] }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const promise = buildDispatcher(send, updateMany).dispatch(buildClaimed());
    expect(send).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
    resolveSend?.({ ids: ['i'] });
    await promise;
    const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
    expect(arg.data.status).toBe(OutboxEventStatus.PUBLISHED);
  });
  it('marks PUBLISHED via updateMany with an id+lockToken compare-and-set', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await buildDispatcher(send, updateMany).dispatch(
      buildClaimed({ id: 'evt-cas', lockToken: 'lock-cas' }),
    );
    const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
    expect(arg.where).toEqual({ id: 'evt-cas', lockToken: 'lock-cas' });
    expect(arg.data.status).toBe(OutboxEventStatus.PUBLISHED);
    expect(arg.data.publishedAt).toBeInstanceOf(Date);
    expect(arg.data.lockToken).toBeNull();
    expect(arg.data.lockedUntil).toBeNull();
    expect(arg.data.lastError).toBeNull();
  });
  it('on reject marks PENDING with bumped retryCount, backed-off nextAttemptAt, and lastError; at maxRetries marks FAILED (CAS)', async () => {
    const send = jest.fn().mockRejectedValue(new Error('Inngest down'));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const random = jest.spyOn(Math, 'random');
    const before = Date.now();
    await buildDispatcher(send, updateMany).dispatch(
      buildClaimed({ retryCount: 1 }),
    );
    const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
    expect(arg.where).toEqual({ id: 'evt-1', lockToken: 'lock-1' });
    expect(arg.data.status).toBe(OutboxEventStatus.PENDING);
    expect(arg.data.retryCount).toBe(2);
    expect(arg.data.lastError).toMatch(/Inngest down/);
    const delay = (arg.data.nextAttemptAt as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(2_000);
    expect(delay).toBeLessThanOrEqual(6_000);
    // retryCount=4 → next=5 === maxRetries ⇒ FAILED.
    updateMany.mockClear();
    await buildDispatcher(send, updateMany).dispatch(
      buildClaimed({ retryCount: 4 }),
    );
    const failed = callArgs(updateMany)[0][0] as UpdateManyCall;
    expect(failed.data.status).toBe(OutboxEventStatus.FAILED);
    expect(failed.data.retryCount).toBe(5);
    // Two failures ⇒ one jitter draw each (a double draw would report 4).
    expect(random).toHaveBeenCalledTimes(2);
    random.mockRestore();
  });
  it('does NOT re-throw a send rejection (one poison row must not abort a poller batch)', async () => {
    const send = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      buildDispatcher(send, jest.fn().mockResolvedValue({ count: 1 })).dispatch(
        buildClaimed(),
      ),
    ).resolves.toBeUndefined();
  });
  it('does NOT throw or clobber when the CAS matches no row (count=0) on both terminal paths', async () => {
    const debug = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const zero = jest.fn().mockResolvedValue({ count: 0 });
    const sends = [
      jest.fn().mockResolvedValue({ ids: ['i'] }),
      jest.fn().mockRejectedValue(new Error('down')),
    ];
    for (const send of sends) {
      await expect(
        buildDispatcher(send, zero).dispatch(
          buildClaimed({ lockToken: 'stale' }),
        ),
      ).resolves.toBeUndefined();
    }
    expect(zero).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });
});
