import { Logger } from '@nestjs/common';
import { OutboxEventStatus } from '@prisma/client';
import type { DispatchableOutboxEvent } from '../../shared/outbox/outbox.types';
import {
  PromotionExpiryOutboxDispatcher,
  computeIdempotencyKey,
} from './promotion-expiry-outbox.dispatcher';

const PAYLOAD = {
  tenantId: 'tenant-1',
  promotionId: 'promotion-1',
  endDate: '2026-07-01T00:00:00.000Z',
  endDateFingerprint: '2026-07-01T00:00:00.000Z',
  occurredAt: '2026-06-24T00:00:00.000Z',
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
    eventType: 'promotion.expiring.detected',
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
): PromotionExpiryOutboxDispatcher {
  return new PromotionExpiryOutboxDispatcher(
    { send } as never,
    { outboxEvent: { updateMany } } as never,
    maxRetries,
  );
}

function callArgs(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}

describe('PromotionExpiryOutboxDispatcher (pca-3c3a)', () => {
  it('sends the contract name, the verbatim payload, and the fingerprint-scoped key', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const claimed = buildClaimed();
    await buildDispatcher(
      send,
      jest.fn().mockResolvedValue({ count: 1 }),
    ).dispatch(claimed);
    const call = callArgs(send)[0];
    expect(call[0]).toBe('promotion/expiring.detected');
    expect(call[1]).toBe(claimed.payload);
    expect(call[2]).toBe('tenant-1:promotion-1:2026-07-01T00:00:00.000Z');
  });

  it('dedupes A→B→A on the same end-date fingerprint while keeping B independently addressable', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const dispatcher = buildDispatcher(
      send,
      jest.fn().mockResolvedValue({ count: 1 }),
    );
    const fingerprintA = '2026-07-01T00:00:00.000Z';
    const fingerprintB = '2026-07-15T00:00:00.000Z';
    await dispatcher.dispatch(buildClaimed());
    await dispatcher.dispatch(
      buildClaimed({
        payload: {
          ...PAYLOAD,
          endDate: fingerprintB,
          endDateFingerprint: fingerprintB,
        },
      }),
    );
    await dispatcher.dispatch(buildClaimed());
    expect(callArgs(send).map((c) => c[2])).toEqual([
      `tenant-1:promotion-1:${fingerprintA}`,
      `tenant-1:promotion-1:${fingerprintB}`,
      `tenant-1:promotion-1:${fingerprintA}`,
    ]);
  });

  it('never sends a fallback key: malformed or foreign identity cannot reach send and schedules retry', async () => {
    const overrides: Array<Partial<typeof PAYLOAD>> = [
      { tenantId: '' },
      { promotionId: '' },
      { endDateFingerprint: '' },
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
      expect(arg.data.lastError).toMatch(/PROMOTION_EXPIRY_INVALID_IDENTITY/);
    }
  });

  it('rejects a non-object or foreign-shaped payload as an unusable identity', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const dispatcher = buildDispatcher(send, updateMany);
    for (const payload of [null, 'raw-string', ['tenant-1'], 42]) {
      updateMany.mockClear();
      await expect(
        dispatcher.dispatch(buildClaimed({ payload: payload as never })),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
      expect(arg.data.lastError).toMatch(/PROMOTION_EXPIRY_INVALID_IDENTITY/);
    }
  });

  it('derives the key from the payload identity, not from the row aggregate', () => {
    const event = buildClaimed({ id: 'evt-key', aggregateId: 'promotion-1' });
    expect(computeIdempotencyKey(event)).toBe(
      'tenant-1:promotion-1:2026-07-01T00:00:00.000Z',
    );
  });

  it('keys on the fingerprint, never on the rendered endDate or occurredAt', () => {
    const event = buildClaimed({
      payload: {
        ...PAYLOAD,
        endDate: '2026-06-30T12:00:00.000Z',
        endDateFingerprint: '2026-07-01T00:00:00.000Z',
        occurredAt: '2026-06-24T00:00:00.000Z',
      },
    });
    expect(computeIdempotencyKey(event)).toBe(
      'tenant-1:promotion-1:2026-07-01T00:00:00.000Z',
    );
  });

  it('isolates a poison row: a later healthy row still publishes with its own key', async () => {
    const send = jest.fn().mockResolvedValue({ ids: ['i'] });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const dispatcher = buildDispatcher(send, updateMany);
    await dispatcher.dispatch(
      buildClaimed({ payload: { ...PAYLOAD, tenantId: '' } }),
    );
    await dispatcher.dispatch(
      buildClaimed({ id: 'evt-2', lockToken: 'lock-2' }),
    );
    expect(callArgs(send)).toHaveLength(1);
    expect(callArgs(send)[0][2]).toBe(
      'tenant-1:promotion-1:2026-07-01T00:00:00.000Z',
    );
    const published = callArgs(updateMany)[1][0] as UpdateManyCall;
    expect(published.where).toEqual({ id: 'evt-2', lockToken: 'lock-2' });
    expect(published.data.status).toBe(OutboxEventStatus.PUBLISHED);
  });

  it('keeps the retry backoff bounded: it grows with the retry count and clamps at the table cap', async () => {
    const send = jest.fn().mockRejectedValue(new Error('down'));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const dispatcher = buildDispatcher(send, updateMany, 100);
    const delays: number[] = [];
    for (const retryCount of [0, 1, 3, 50]) {
      updateMany.mockClear();
      const before = Date.now();
      await dispatcher.dispatch(buildClaimed({ retryCount }));
      const arg = callArgs(updateMany)[0][0] as UpdateManyCall;
      delays.push((arg.data.nextAttemptAt as Date).getTime() - before);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(2_000);
    expect(delays[0]).toBeLessThanOrEqual(2_500);
    expect(delays[2]).toBeGreaterThanOrEqual(54_000);
    // retryCount=50 must NOT grow beyond the 300s cap (+10% jitter + clock slack).
    expect(delays[3]).toBeLessThanOrEqual(331_000);
    expect(delays[3]).toBeGreaterThanOrEqual(270_000);
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
    expect(arg.data.retryCount).toBe(0);
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
