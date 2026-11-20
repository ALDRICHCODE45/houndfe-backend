/**
 * restock-backorder / T3 — lock order and error mapping of the checkout side
 * of a backorder (L7/L10): every product of the cart BEFORE any backorder row,
 * rows in id order, the feed item of a lost reservation last.
 */
import { BackorderCheckoutError } from '../../sales/domain/backorder-checkout.port';
import { BackorderCheckoutService } from './backorder-checkout.service';

jest.mock('./backorder-feed-writes', () => ({
  enqueueBackorderReservationLost: jest.fn(),
}));
import { enqueueBackorderReservationLost } from './backorder-feed-writes';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 3_600_000);
const row = (id: string, overrides: object = {}) => ({
  id,
  status: 'RESERVED',
  customerId: 'c-1',
  productId: 'p-1',
  variantId: null,
  quantity: 2,
  finalPriceCents: 900,
  reservedUntil: FUTURE,
  ...overrides,
});

function harness(rows: Record<string, object | null> = {}) {
  const calls: string[] = [];
  const tx = {
    backorder: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) => {
        calls.push(`read:${where.id}`);
        return Promise.resolve(
          where.id in rows ? rows[where.id] : row(where.id),
        );
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const tenantPrisma = {
    getTenantId: () => 't-1',
    getClient: () => tx,
    runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
  };
  const writer = {
    lockStock: jest.fn((ids: string[]) => {
      calls.push(`lock:${ids.join(',')}`);
      return Promise.resolve();
    }),
  };
  const revalidate = jest.fn((_tx: unknown, id: string) => {
    calls.push(`revalidate:${id}`);
    return Promise.resolve({ outcome: 'VALID' } as { outcome: string });
  });
  const registry = { register: jest.fn() };
  const service = new BackorderCheckoutService(
    tenantPrisma as never,
    writer as never,
    { revalidateReservation: revalidate } as never,
    registry as never,
  );
  return { service, calls, tx, writer, revalidate, registry, tenantPrisma };
}

const line = (backorderId: string, productId = 'p-1') => ({
  backorderId,
  productId,
  variantId: null,
  quantity: 2,
  unitPriceCents: 900,
});

describe('BackorderCheckoutService', () => {
  beforeEach(() => jest.mocked(enqueueBackorderReservationLost).mockClear());

  it('registers itself with the checkout registry (no lifecycle hook)', () => {
    const { service, registry } = harness();
    expect(registry.register).toHaveBeenCalledWith(service);
  });

  it('lockAndVerify locks EVERY product of the cart first, then the backorders in id order', async () => {
    const { service, calls } = harness({
      'bo-b': row('bo-b', { productId: 'p-2' }),
    });
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-b', 'p-2'), line('bo-a', 'p-1')],
      productIds: ['p-1', 'p-2', 'p-3'],
    });

    await handle.lockAndVerify(NOW);

    expect(calls[0]).toBe('lock:p-1,p-2,p-3');
    expect(calls.filter((c) => c.startsWith('revalidate:'))).toEqual([
      'revalidate:bo-a',
      'revalidate:bo-b',
    ]);
    expect(calls.indexOf('revalidate:bo-a')).toBeGreaterThan(0);
  });

  it.each([
    [{ outcome: 'NOT_RESERVED', status: null }, 'BACKORDER_NOT_FOUND', {}],
    [
      { outcome: 'NOT_RESERVED', status: 'CANCELLED' },
      'BACKORDER_NOT_RESERVED',
      { status: 'CANCELLED' },
    ],
    [{ outcome: 'NOT_HELD' }, 'BACKORDER_RESERVATION_UNAVAILABLE', {}],
    [{ outcome: 'RESERVATION_LOST' }, 'BACKORDER_RESERVATION_LOST', {}],
  ])('lockAndVerify maps %j to %s', async (outcome, code, details) => {
    const { service, revalidate } = harness();
    revalidate.mockResolvedValueOnce(outcome as never);
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-a')],
      productIds: ['p-1'],
    });

    await expect(handle.lockAndVerify(NOW)).rejects.toMatchObject({
      code,
      details,
    });
  });

  it('lockAndVerify re-applies the rules to the LOCKED row (a stale early read is not trusted)', async () => {
    const { service } = harness({ 'bo-a': row('bo-a', { quantity: 5 }) });
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-a')],
      productIds: ['p-1'],
    });

    await expect(handle.lockAndVerify(NOW)).rejects.toMatchObject({
      code: 'BACKORDER_MISMATCH',
      details: { field: 'quantity' },
    });
  });

  it('inspect validates without locking and returns the frozen prices', async () => {
    const { service, writer, revalidate } = harness({
      'bo-a': row('bo-a', { finalPriceCents: 900 }),
    });
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-a')],
      productIds: ['p-1'],
    });

    expect(await handle.inspect(NOW)).toEqual(new Map([['bo-a', 900]]));
    expect(writer.lockStock).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('inspect refuses an unknown backorder with 404', async () => {
    const { service } = harness({ 'bo-a': null });
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-a')],
      productIds: ['p-1'],
    });
    await expect(handle.inspect(NOW)).rejects.toBeInstanceOf(
      BackorderCheckoutError,
    );
  });

  it('markConfirmed moves each backorder RESERVED → CONFIRMED with the sale and bumps the version; a lost race rolls the checkout back', async () => {
    const { service, tx } = harness();
    const handle = service.forCheckout({
      customerId: 'c-1',
      lines: [line('bo-a')],
      productIds: ['p-1'],
    });

    await handle.markConfirmed('sale-1', NOW);
    expect(tx.backorder.updateMany).toHaveBeenCalledWith({
      where: { id: 'bo-a', tenantId: 't-1', status: 'RESERVED' },
      data: {
        status: 'CONFIRMED',
        saleId: 'sale-1',
        confirmedAt: NOW,
        version: { increment: 1 },
      },
    });

    tx.backorder.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(handle.markConfirmed('sale-1', NOW)).rejects.toThrow(
      /left RESERVED/,
    );
  });

  describe('settleExpiredLots', () => {
    it('settles each live reservation in its own transaction, in id order, and feeds the loss after the revalidation', async () => {
      const { service, revalidate, tenantPrisma, calls } = harness();
      revalidate.mockImplementation((_tx, id: string) => {
        calls.push(`revalidate:${id}`);
        return Promise.resolve(
          id === 'bo-a'
            ? { outcome: 'RESERVATION_LOST' }
            : { outcome: 'SWAPPED' },
        );
      });
      jest.mocked(enqueueBackorderReservationLost).mockImplementation(() => {
        calls.push('feed');
        return Promise.resolve(true);
      });

      const lost = await service.settleExpiredLots(['bo-b', 'bo-a', 'bo-a']);

      expect(lost).toBe('bo-a');
      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(2);
      expect(
        calls.filter((c) => c.startsWith('revalidate') || c === 'feed'),
      ).toEqual(['revalidate:bo-a', 'feed', 'revalidate:bo-b']);
      expect(enqueueBackorderReservationLost).toHaveBeenCalledTimes(1);
    });

    it('does not touch a reservation that is not live (the checkout refuses it by its own rules)', async () => {
      const { service, revalidate } = harness({ 'bo-a': null });
      expect(await service.settleExpiredLots(['bo-a'])).toBeNull();
      expect(revalidate).not.toHaveBeenCalled();
    });
  });
});
