import { Logger } from '@nestjs/common';
import type { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import type { AppliedStockMovement } from '../../inventory/domain/stock-journal.types';
import type { SalesService } from '../../sales/sales.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BackorderAllocator } from './backorder-allocator';
import type { BackorderReservedHook } from './ports/backorder-reserved-hook.port';

const TENANT = 't1';
const NOW = new Date('2026-11-20T15:00:00.000Z');

interface QueueRow {
  id: string;
  folio: string;
  quantity: number;
  customerId: string;
  referencePriceCents: number;
}

const row = (
  id: string,
  quantity: number,
  over: Partial<QueueRow> = {},
): QueueRow => ({
  id,
  folio: `BO-${id}`,
  quantity,
  customerId: `c-${id}`,
  referencePriceCents: 1000,
  ...over,
});

const movement = (id: string): AppliedStockMovement =>
  ({ id }) as AppliedStockMovement;

function setup(
  options: {
    waiting?: boolean;
    sellable?: number | null;
    queue?: QueueRow[];
    /** unit price per backorder id; null = no catalog price; number = line final total / qty */
    lineFinal?: Record<string, number | 'NO_PRICE'>;
  } = {},
) {
  const order: string[] = [];
  const tx = {
    backorder: {
      findFirst: jest.fn(() => {
        order.push('exists');
        return Promise.resolve(options.waiting === false ? null : { id: 'x' });
      }),
      update: jest.fn(() => {
        order.push('update');
        return Promise.resolve({});
      }),
      updateMany: jest.fn(() => {
        order.push('updateMany');
        return Promise.resolve({ count: 0 });
      }),
    },
    $queryRaw: jest.fn(() => {
      order.push('queue');
      return Promise.resolve(options.queue ?? []);
    }),
  };
  const tenantPrisma = {
    getClient: jest.fn(() => tx),
    getTenantId: jest.fn(() => TENANT),
  } as unknown as TenantPrismaService;
  const writer = {
    registerStockIncreaseListener: jest.fn(),
    lockSellable: jest.fn(() => {
      order.push('lockSellable');
      return Promise.resolve(
        options.sellable === undefined ? 10 : options.sellable,
      );
    }),
    reserveBackorder: jest.fn((input: { backorderId: string }) => {
      order.push(`reserve:${input.backorderId}`);
      return Promise.resolve([movement(`m-${input.backorderId}`)]);
    }),
  };
  const sales = {
    previewBotPricing: jest.fn(
      (input: { customerId: string; items: Array<{ quantity: number }> }) => {
        const id = input.customerId.replace('c-', '');
        const line = options.lineFinal?.[id];
        if (line === 'NO_PRICE') {
          return Promise.reject(
            new BusinessRuleViolationError(
              'PRICE_OUT_OF_DATE',
              'PRICE_OUT_OF_DATE',
            ),
          );
        }
        const quantity = input.items[0].quantity;
        return Promise.resolve({
          items: [
            {
              unitPriceCents: 1000,
              finalPriceCents: line ?? 900 * quantity,
            },
          ],
        });
      },
    ),
  };
  const onReserved = jest.fn(() => {
    order.push('hook');
    return Promise.resolve();
  });
  const hook: BackorderReservedHook = { onReserved };
  const allocator = new BackorderAllocator(
    tenantPrisma,
    writer as unknown as StockJournalWriter,
    sales as unknown as SalesService,
    hook,
  );
  return {
    allocator,
    tx,
    writer,
    sales,
    hook,
    onReserved,
    order,
    tenantPrisma,
  };
}

describe('BackorderAllocator', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('registers itself as the journal increase listener when it is built (no lifecycle hook)', () => {
    const { allocator, writer } = setup();
    expect(writer.registerStockIncreaseListener).toHaveBeenCalledWith(
      allocator,
    );
    expect(
      (allocator as unknown as { onModuleInit?: unknown }).onModuleInit,
    ).toBeUndefined();
  });

  describe('no work', () => {
    it('does nothing (no stock lock, no queue lock) when no backorder is WAITING for the product/variant', async () => {
      const { allocator, tx, writer } = setup({ waiting: false });
      const result = await allocator.allocate(
        tx as never,
        TENANT,
        'p1',
        null,
        NOW,
      );
      expect(result).toEqual({
        reservedIds: [],
        passedOverIds: [],
        unpricedIds: [],
        movements: [],
      });
      expect(tx.backorder.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT,
          productId: 'p1',
          variantId: null,
          status: 'WAITING',
        },
        select: { id: true },
      });
      expect(writer.lockSellable).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([0, null])(
      'does not lock the queue when sellable is %p',
      async (sellable) => {
        const { allocator, tx, writer } = setup({ sellable });
        const result = await allocator.allocate(
          tx as never,
          TENANT,
          'p1',
          'v1',
          NOW,
        );
        expect(result.reservedIds).toEqual([]);
        expect(writer.lockSellable).toHaveBeenCalledWith('p1', 'v1', NOW);
        expect(tx.$queryRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe('lock order (journal locks first, then the backorder rows)', () => {
    it('locks the stock before the queue, reserves in queue order, then updates each row', async () => {
      const { allocator, tx, order } = setup({
        queue: [row('a', 2), row('b', 3)],
      });
      await allocator.allocate(tx as never, TENANT, 'p1', null, NOW);
      expect(order).toEqual([
        'exists',
        'lockSellable',
        'queue',
        'reserve:a',
        'update',
        'hook',
        'reserve:b',
        'update',
        'hook',
      ]);
    });
  });

  describe('reservation', () => {
    it('marks RESERVED with the 24 h window, reminder 3 h before, stage 0 and the min price', async () => {
      const { allocator, tx, writer, sales } = setup({
        queue: [row('a', 2, { referencePriceCents: 1000 })],
        lineFinal: { a: 1800 }, // 2 units at a promo price of 900 each
      });
      const result = await allocator.allocate(
        tx as never,
        TENANT,
        'p1',
        null,
        NOW,
      );
      expect(sales.previewBotPricing).toHaveBeenCalledWith({
        customerId: 'c-a',
        items: [
          { productId: 'p1', variantId: null, quantity: 2, unitPriceCents: 0 },
        ],
      });
      expect(writer.reserveBackorder).toHaveBeenCalledWith(
        expect.objectContaining({
          backorderId: 'a',
          productId: 'p1',
          variantId: null,
          quantity: 2,
          actor: { id: null, displayName: 'Sistema' },
        }),
        expect.any(Date),
      );
      expect(tx.backorder.update).toHaveBeenCalledWith({
        where: { id: 'a', tenantId: TENANT },
        data: {
          status: 'RESERVED',
          reservedAt: NOW,
          reservedUntil: new Date('2026-11-21T15:00:00.000Z'),
          reminderAt: new Date('2026-11-21T12:00:00.000Z'),
          reservationStage: 0,
          currentPriceCents: 900,
          finalPriceCents: 900,
          version: { increment: 1 },
        },
      });
      expect(result.reservedIds).toEqual(['a']);
      expect(result.movements.map((m) => m.id)).toEqual(['m-a']);
    });

    it('final price is min(reference, current): a higher current price does not raise it', async () => {
      const { allocator, tx } = setup({
        queue: [row('a', 1, { referencePriceCents: 1000 })],
        lineFinal: { a: 1200 },
      });
      await allocator.allocate(tx as never, TENANT, 'p1', null, NOW);
      const [call] = tx.backorder.update.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(call[0].data).toMatchObject({
        currentPriceCents: 1200,
        finalPriceCents: 1000,
      });
    });

    it('prices a variant backorder with its variantId', async () => {
      const { allocator, tx, sales } = setup({ queue: [row('a', 1)] });
      await allocator.allocate(tx as never, TENANT, 'p1', 'v1', NOW);
      expect(sales.previewBotPricing).toHaveBeenCalledWith({
        customerId: 'c-a',
        items: [
          { productId: 'p1', variantId: 'v1', quantity: 1, unitPriceCents: 0 },
        ],
      });
    });

    it('hands the reserved backorder to the post-reserve hook inside the same call', async () => {
      const { allocator, tx, onReserved } = setup({ queue: [row('a', 1)] });
      await allocator.allocate(tx as never, TENANT, 'p1', null, NOW);
      expect(onReserved).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          tenantId: TENANT,
          backorderId: 'a',
          folio: 'BO-a',
          customerId: 'c-a',
          productId: 'p1',
          variantId: null,
          quantity: 1,
          referencePriceCents: 1000,
          currentPriceCents: 900,
          finalPriceCents: 900,
          reservedAt: NOW,
          reservedUntil: new Date('2026-11-21T15:00:00.000Z'),
          reminderAt: new Date('2026-11-21T12:00:00.000Z'),
        }),
      );
    });

    it('stamps successive reservations strictly after each other (kardex order = journal order)', async () => {
      const { allocator, tx, writer } = setup({
        queue: [row('a', 1), row('b', 1)],
      });
      await allocator.allocate(tx as never, TENANT, 'p1', null, NOW);
      const calls = writer.reserveBackorder.mock.calls as unknown as Array<
        [unknown, Date]
      >;
      expect(calls[0][1].getTime()).toBeGreaterThanOrEqual(NOW.getTime());
      expect(calls[1][1].getTime()).toBeGreaterThan(calls[0][1].getTime());
    });
  });

  describe('queue walk (owner Q1)', () => {
    it('never partially reserves: a head that does not fit is passed over by those behind that do', async () => {
      const { allocator, tx, writer } = setup({
        sellable: 3,
        queue: [row('head', 5), row('b', 2), row('c', 1)],
      });
      const result = await allocator.allocate(
        tx as never,
        TENANT,
        'p1',
        null,
        NOW,
      );
      expect(
        writer.reserveBackorder.mock.calls.map(
          (c) => (c as unknown as [{ backorderId: string }])[0].backorderId,
        ),
      ).toEqual(['b', 'c']);
      expect(result.reservedIds).toEqual(['b', 'c']);
      expect(result.passedOverIds).toEqual(['head']);
      expect(tx.backorder.updateMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT, id: { in: ['head'] } },
        data: { passedOverCount: { increment: 1 } },
      });
    });

    it('does not touch passedOverCount when nobody behind a miss was reserved', async () => {
      const { allocator, tx } = setup({
        sellable: 1,
        queue: [row('a', 1), row('head', 5)],
      });
      await allocator.allocate(tx as never, TENANT, 'p1', null, NOW);
      expect(tx.backorder.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('price that cannot be computed', () => {
    it('keeps the backorder WAITING, logs it, and serves the next one', async () => {
      const { allocator, tx, writer, onReserved } = setup({
        sellable: 2,
        queue: [row('a', 2), row('b', 2)],
        lineFinal: { a: 'NO_PRICE' },
      });
      const result = await allocator.allocate(
        tx as never,
        TENANT,
        'p1',
        null,
        NOW,
      );
      expect(result.unpricedIds).toEqual(['a']);
      expect(result.reservedIds).toEqual(['b']);
      expect(writer.reserveBackorder).toHaveBeenCalledTimes(1);
      expect(tx.backorder.update).toHaveBeenCalledTimes(1);
      expect(onReserved).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a'));
    });

    it('propagates an unexpected pricing failure instead of reserving blind', async () => {
      const { allocator, tx, sales, writer } = setup({ queue: [row('a', 1)] });
      sales.previewBotPricing.mockRejectedValueOnce(new Error('db down'));
      await expect(
        allocator.allocate(tx as never, TENANT, 'p1', null, NOW),
      ).rejects.toThrow('db down');
      expect(writer.reserveBackorder).not.toHaveBeenCalled();
    });
  });

  describe('increase listener', () => {
    it('allocates every touched product/variant inside the ambient transaction and returns the movements', async () => {
      const { allocator, tx } = setup({ queue: [row('a', 1)] });
      const spy = jest.spyOn(allocator, 'allocate');
      const movements = await allocator.onStockIncreased(
        [
          { productId: 'p1', variantId: null },
          { productId: 'p2', variantId: 'v9' },
        ],
        NOW,
      );
      expect(spy).toHaveBeenNthCalledWith(1, tx, TENANT, 'p1', null, NOW);
      expect(spy).toHaveBeenNthCalledWith(2, tx, TENANT, 'p2', 'v9', NOW);
      expect(movements.length).toBeGreaterThan(0);
    });
  });
});
