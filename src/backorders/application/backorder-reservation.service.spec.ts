import type { AppliedStockMovement } from '../../inventory/domain/stock-journal.types';
import type { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { LowStockCrossing } from '../../stock-alerts/infrastructure/low-stock-crossing.service';
import type { BackorderAllocator } from './backorder-allocator';
import { BackorderReservationService } from './backorder-reservation.service';

const TENANT = 't1';
const NOW = new Date('2026-11-20T15:00:00.000Z');
const mv = (id: string) => ({ id }) as AppliedStockMovement;

function setup(
  options: {
    row?: {
      status: string;
      productId: string;
      variantId: string | null;
    } | null;
    lockedStatus?: string | null;
    revalidation?: unknown;
    allocation?: { movements: AppliedStockMovement[]; reservedIds: string[] };
  } = {},
) {
  const order: string[] = [];
  const row =
    options.row === undefined
      ? { status: 'RESERVED', productId: 'p1', variantId: null }
      : options.row;
  const tx = {
    backorder: {
      findFirst: jest.fn(() => {
        order.push('read');
        return Promise.resolve(row);
      }),
      update: jest.fn(() => {
        order.push('update');
        return Promise.resolve({});
      }),
    },
    $queryRaw: jest.fn(() => {
      order.push('rowLock');
      const status =
        options.lockedStatus === undefined ? 'RESERVED' : options.lockedStatus;
      return Promise.resolve(status === null ? [] : [{ id: 'bo', status }]);
    }),
  };
  const tenantPrisma = {
    getClient: jest.fn(() => tx),
    getTenantId: jest.fn(() => TENANT),
  } as unknown as TenantPrismaService;
  const writer = {
    lockStock: jest.fn(() => {
      order.push('lockStock');
      return Promise.resolve();
    }),
    releaseBackorder: jest.fn(() => {
      order.push('release');
      return Promise.resolve([mv('rel')]);
    }),
    revalidateBackorder: jest.fn(() => {
      order.push('revalidate');
      return Promise.resolve(
        options.revalidation ?? { status: 'VALID', movements: [] },
      );
    }),
  };
  const allocator = {
    allocate: jest.fn(() => {
      order.push('allocate');
      return Promise.resolve({
        reservedIds: options.allocation?.reservedIds ?? [],
        passedOverIds: [],
        unpricedIds: [],
        movements: options.allocation?.movements ?? [],
      });
    }),
  };
  const crossing = {
    record: jest.fn(() => {
      order.push('crossing');
      return Promise.resolve();
    }),
  };
  const service = new BackorderReservationService(
    tenantPrisma,
    writer as unknown as StockJournalWriter,
    allocator as unknown as BackorderAllocator,
    crossing as unknown as LowStockCrossing,
  );
  return { service, tx, writer, allocator, crossing, order };
}

describe('BackorderReservationService.releaseReservation', () => {
  it('releases through the journal (allocation of the next one is the writer’s increase seam) and feeds the low-stock edge', async () => {
    const { service, writer, crossing } = setup();
    await service.releaseReservation({
      tenantId: TENANT,
      backorderId: 'bo',
      productId: 'p1',
      variantId: null,
      quantity: 2,
    });
    expect(writer.releaseBackorder).toHaveBeenCalledWith({
      backorderId: 'bo',
      actor: { id: null, displayName: 'Sistema' },
    });
    expect(crossing.record).toHaveBeenCalledWith([mv('rel')]);
  });

  it('uses the actor of the caller (customer cancel through the bot)', async () => {
    const { service, writer } = setup();
    await service.releaseReservation({
      tenantId: TENANT,
      backorderId: 'bo',
      productId: 'p1',
      variantId: null,
      quantity: 2,
      actor: { id: null, displayName: 'Bot' },
    });
    expect(writer.releaseBackorder).toHaveBeenCalledWith({
      backorderId: 'bo',
      actor: { id: null, displayName: 'Bot' },
    });
  });
});

describe('BackorderReservationService.revalidateReservation', () => {
  it.each([
    ['unknown', null],
    ['WAITING', { status: 'WAITING', productId: 'p1', variantId: null }],
    ['CONFIRMED', { status: 'CONFIRMED', productId: 'p1', variantId: null }],
  ])(
    '%s backorder: NOT_RESERVED, no lock, no journal call',
    async (_n, row) => {
      const { service, tx, writer } = setup({ row });
      const result = await service.revalidateReservation(
        tx as never,
        'bo',
        NOW,
      );
      expect(result.outcome).toBe('NOT_RESERVED');
      expect(writer.lockStock).not.toHaveBeenCalled();
      expect(writer.revalidateBackorder).not.toHaveBeenCalled();
    },
  );

  it('locks the stock BEFORE the backorder row (journal lock order)', async () => {
    const { service, tx, order } = setup();
    await service.revalidateReservation(tx as never, 'bo', NOW);
    expect(order).toEqual(['read', 'lockStock', 'rowLock', 'revalidate']);
  });

  it('is NOT_RESERVED when the row stopped being RESERVED while waiting for the lock', async () => {
    const { service, tx, writer } = setup({ lockedStatus: 'CANCELLED' });
    expect(
      (await service.revalidateReservation(tx as never, 'bo', NOW)).outcome,
    ).toBe('NOT_RESERVED');
    expect(writer.revalidateBackorder).not.toHaveBeenCalled();
  });

  it('VALID: nothing changes', async () => {
    const { service, tx } = setup();
    const result = await service.revalidateReservation(tx as never, 'bo', NOW);
    expect(result.outcome).toBe('VALID');
    expect(tx.backorder.update).not.toHaveBeenCalled();
  });

  it('NOT_HELD: a RESERVED row with no journal hold is reported, not repaired', async () => {
    const { service, tx } = setup({
      revalidation: { status: 'NOT_HELD', movements: [] },
    });
    expect(
      (await service.revalidateReservation(tx as never, 'bo', NOW)).outcome,
    ).toBe('NOT_HELD');
    expect(tx.backorder.update).not.toHaveBeenCalled();
  });

  it('SWAPPED: stays RESERVED (row untouched), feeds the low-stock edge, no allocation', async () => {
    const { service, tx, crossing, allocator } = setup({
      revalidation: { status: 'SWAPPED', movements: [mv('r'), mv('s')] },
    });
    const result = await service.revalidateReservation(tx as never, 'bo', NOW);
    expect(result.outcome).toBe('SWAPPED');
    expect(tx.backorder.update).not.toHaveBeenCalled();
    expect(allocator.allocate).not.toHaveBeenCalled();
    expect(crossing.record).toHaveBeenCalledWith([mv('r'), mv('s')]);
  });

  it('RESERVATION_LOST: back to WAITING keeping scheduledAt, reservation fields and prices cleared, then the queue is served', async () => {
    const { service, tx, allocator, crossing, order } = setup({
      revalidation: { status: 'LOST', movements: [mv('rel1'), mv('rel2')] },
      allocation: { movements: [mv('res')], reservedIds: ['other'] },
    });
    const result = await service.revalidateReservation(tx as never, 'bo', NOW);
    expect(result).toEqual({
      outcome: 'RESERVATION_LOST',
      backorderId: 'bo',
      productId: 'p1',
      variantId: null,
      reservedIds: ['other'],
    });
    expect(tx.backorder.update).toHaveBeenCalledWith({
      where: { id: 'bo', tenantId: TENANT },
      data: {
        status: 'WAITING',
        reservedAt: null,
        reservedUntil: null,
        reminderAt: null,
        reservationStage: 0,
        currentPriceCents: null,
        finalPriceCents: null,
        version: { increment: 1 },
      },
    });
    // scheduledAt is never written: the backorder keeps its place in the queue.
    const data = (
      tx.backorder.update.mock.calls[0] as unknown as [{ data: object }]
    )[0].data;
    expect(data).not.toHaveProperty('scheduledAt');
    expect(allocator.allocate).toHaveBeenCalledWith(
      tx,
      TENANT,
      'p1',
      null,
      NOW,
    );
    // The row is WAITING before the allocator looks at the queue.
    expect(order).toEqual([
      'read',
      'lockStock',
      'rowLock',
      'revalidate',
      'update',
      'allocate',
      'crossing',
    ]);
    expect(crossing.record).toHaveBeenCalledWith([
      mv('rel1'),
      mv('rel2'),
      mv('res'),
    ]);
  });
});
