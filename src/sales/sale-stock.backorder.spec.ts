/**
 * restock-backorder / T3 — `SaleStockService.chargeConsumingBackorders`: a sale
 * line that confirms a RESERVED backorder takes the held units without
 * allocating them to anybody else in between (contract v1 §7.4).
 */
import {
  InsufficientStockError,
  StockBucketNotFoundError,
} from '../inventory/domain/stock-journal.errors';
import type { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import type { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { IStockAlertStateRepository } from '../stock-alerts/domain/stock-alert-state.repository';
import { SaleStockService } from './sale-stock.service';

const CASHIER = '30000000-0000-4000-8000-000000000001';
const PRODUCT = '40000000-0000-4000-8000-000000000001';

const movement = (type: string, delta: number, balanceAfter: number) => ({
  type,
  productId: PRODUCT,
  variantId: null,
  delta,
  balanceAfter,
  productBalanceAfter: balanceAfter,
});

function makeService() {
  const calls: string[] = [];
  const journal = {
    releaseBackorder: jest.fn((input: { backorderId: string }) => {
      calls.push(`release:${input.backorderId}`);
      return Promise.resolve([movement('BACKORDER_RELEASE', 2, 2)]);
    }),
    charge: jest.fn(() => {
      calls.push('charge');
      return Promise.resolve([movement('SALE', -3, 0)]);
    }),
  };
  const tenantPrisma = {
    getClient: () => ({}),
    getTenantId: () => 'tenant-1',
  };
  const service = new SaleStockService(
    journal as unknown as StockJournalWriter,
    tenantPrisma as unknown as TenantPrismaService,
    { publish: jest.fn() } as unknown as OutboxWriterService,
    {} as IStockAlertStateRepository,
  );
  const record = jest.fn().mockResolvedValue(undefined);
  (service as unknown as { crossing: { record: jest.Mock } }).crossing = {
    record,
  };
  return { service, journal, record, calls };
}

const input = (backorderIds: string[]) => ({
  saleId: 'sale-1',
  items: [{ productId: PRODUCT, quantity: 3 }],
  actor: { kind: 'bot' as const, userId: CASHIER },
  backorderIds,
});

describe('SaleStockService.chargeConsumingBackorders', () => {
  it('releases each backorder WITHOUT allocation, then charges the whole cart, in that order', async () => {
    const { service, journal, calls } = makeService();

    await service.chargeConsumingBackorders(input(['bo-b', 'bo-a']));

    expect(calls).toEqual(['release:bo-b', 'release:bo-a', 'charge']);
    for (const [release] of journal.releaseBackorder.mock.calls) {
      expect(release).toMatchObject({
        allocate: false,
        actor: { id: CASHIER, displayName: 'Bot' },
      });
    }
    expect(journal.charge).toHaveBeenCalledWith(
      [{ productId: PRODUCT, quantity: 3 }],
      { saleId: 'sale-1', actor: { id: CASHIER, displayName: 'Bot' } },
      expect.any(Date),
    );
  });

  it('hands the low-stock edge release + sale rows together (net change, not a drop)', async () => {
    const { service, record } = makeService();

    const rows = await service.chargeConsumingBackorders(input(['bo-a']));

    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0] as unknown[])[0]).toEqual(rows);
    expect(rows.map((row) => row.type)).toEqual(['BACKORDER_RELEASE', 'SALE']);
  });

  it('keeps the sales contract when the stock cannot cover the cart: STOCK_INSUFFICIENT_AT_CONFIRM', async () => {
    for (const cause of [
      new InsufficientStockError('PRODUCT', PRODUCT, 1, 3),
      new StockBucketNotFoundError('PRODUCT', PRODUCT),
    ]) {
      const { service, journal, record } = makeService();
      journal.charge.mockRejectedValueOnce(cause);
      await expect(
        service.chargeConsumingBackorders(input(['bo-a'])),
      ).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT_AT_CONFIRM' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('shares the movement instant: the sale rows are never stamped before the release rows', async () => {
    const { service, journal } = makeService();
    await service.chargeConsumingBackorders({
      ...input(['bo-a']),
      now: new Date('2026-11-20T12:00:00.000Z'),
    });
    const releaseAt = (
      journal.releaseBackorder.mock.calls[0] as unknown as [unknown, Date]
    )[1];
    const chargeAt = (
      journal.charge.mock.calls[0] as unknown as [unknown, unknown, Date]
    )[2];
    expect(releaseAt.toISOString()).toBe('2026-11-20T12:00:00.000Z');
    expect(chargeAt.getTime()).toBeGreaterThan(releaseAt.getTime());
  });
});
