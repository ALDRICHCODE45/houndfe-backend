/**
 * LowStockCrossing — the single low-stock edge (O1 / T6b, L8). Journal rows in,
 * observable effects out: outbox rows written and alert states re-armed.
 */
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { IStockAlertStateRepository } from '../domain/stock-alert-state.repository';
import {
  LowStockCrossing,
  type JournalMovementLike,
} from './low-stock-crossing.service';

const TENANT = 'tenant-1';

const row = (
  over: Partial<JournalMovementLike> & { delta: number; after: number },
): JournalMovementLike => ({
  productId: 'p1',
  variantId: null,
  delta: over.delta,
  balanceAfter: over.after,
  productBalanceAfter: over.after,
  ...over,
});

function build(
  products: Array<{
    id: string;
    minQuantity: number;
    useLotsAndExpirations?: boolean;
  }>,
  variants: Array<{ id: string; minQuantity: number }> = [],
) {
  const db = {
    product: {
      findMany: jest.fn().mockResolvedValue(
        products.map((p) => ({
          useLotsAndExpirations: false,
          ...p,
        })),
      ),
    },
    variant: { findMany: jest.fn().mockResolvedValue(variants) },
  };
  const tenantPrisma = {
    getClient: () => db,
    getTenantId: () => TENANT,
  } as unknown as TenantPrismaService;
  const publish = jest.fn().mockResolvedValue(undefined);
  const outbox = { publish } as unknown as OutboxWriterService;
  const seedAndFlip = jest.fn().mockResolvedValue(1);
  const rearm = jest.fn().mockResolvedValue(1);
  const alertState = { seedAndFlip, rearm } as IStockAlertStateRepository;
  return {
    crossing: new LowStockCrossing(tenantPrisma, outbox, alertState),
    publish,
    seedAndFlip,
    rearm,
  };
}

describe('LowStockCrossing.record', () => {
  it('writes exactly one stock.low.detected row when a product falls from above min to min', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([row({ delta: -4, after: 5 })]);

    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[0].slice(1, 5)).toEqual([
      TENANT,
      'StockAlert',
      'p1:__PRODUCT__',
      'stock.low.detected',
    ]);
    expect(t.publish.mock.calls[0][5]).toMatchObject({
      tenantId: TENANT,
      productId: 'p1',
      variantId: null,
      variantKey: '__PRODUCT__',
      alertEpoch: 1,
      newQuantity: 5,
      minQuantity: 5,
    });
    expect(t.rearm).not.toHaveBeenCalled();
  });

  it('writes nothing when the balance stays above min', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([row({ delta: -1, after: 6 })]);

    expect(t.publish).not.toHaveBeenCalled();
    expect(t.seedAndFlip).not.toHaveBeenCalled();
  });

  it('writes nothing when the balance was already at or below min', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([row({ delta: -1, after: 4 })]);

    expect(t.publish).not.toHaveBeenCalled();
  });

  it('writes nothing for a product that uses lots and expirations', async () => {
    const t = build([
      { id: 'p1', minQuantity: 5, useLotsAndExpirations: true },
    ]);

    await t.crossing.record([row({ delta: -9, after: 1 })]);

    expect(t.publish).not.toHaveBeenCalled();
  });

  it('writes no row when a concurrent transaction already owns the crossing', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);
    t.seedAndFlip.mockResolvedValue(null);

    await t.crossing.record([row({ delta: -9, after: 1 })]);

    expect(t.publish).not.toHaveBeenCalled();
  });

  it('collapses several buckets of one product into a single crossing', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([
      row({ delta: -3, after: 9 }),
      row({ delta: -6, after: 3 }),
    ]);

    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[0][5]).toMatchObject({ newQuantity: 3 });
  });

  it('judges a variant against its own min, not the product min', async () => {
    const t = build(
      [{ id: 'p1', minQuantity: 100 }],
      [{ id: 'v1', minQuantity: 2 }],
    );

    await t.crossing.record([row({ variantId: 'v1', delta: -3, after: 2 })]);

    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[0][3]).toBe('p1:v1');
    expect(t.publish.mock.calls[0][5]).toMatchObject({
      variantId: 'v1',
      variantKey: 'v1',
      newQuantity: 2,
      minQuantity: 2,
    });
  });

  it('re-arms only when the balance rises strictly above min', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([row({ delta: 3, after: 5 })]);
    expect(t.rearm).not.toHaveBeenCalled();

    await t.crossing.record([row({ delta: 1, after: 6 })]);
    expect(t.rearm).toHaveBeenCalledTimes(1);
    expect(t.rearm).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        productId: 'p1',
        variantId: null,
      }),
    );
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('does not re-arm on a decrease that stays above min', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([row({ delta: -1, after: 9 })]);

    expect(t.rearm).not.toHaveBeenCalled();
  });

  it('does nothing and reads nothing for an empty movement list', async () => {
    const t = build([{ id: 'p1', minQuantity: 5 }]);

    await t.crossing.record([]);

    expect(t.publish).not.toHaveBeenCalled();
    expect(t.rearm).not.toHaveBeenCalled();
  });
});
