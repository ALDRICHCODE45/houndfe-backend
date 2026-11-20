/**
 * restock-backorder / T5b — counter sale confirm (contract v1 §4, «Counter sale
 * vs reservation»): when the charge fails for lack of stock and the units the
 * backorders hold would cover the failing line, the answer is
 * 409 STOCK_RESERVED_FOR_BACKORDER {available, reserved}; every other
 * shortage, and every bot checkout, keeps STOCK_INSUFFICIENT_AT_CONFIRM.
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
import { StockReservedForBackorderError } from './stock-reserved-for-backorder.error';

const CASHIER = '30000000-0000-4000-8000-000000000001';
const P1 = '40000000-0000-4000-8000-000000000001';
const P2 = '40000000-0000-4000-8000-000000000002';
const V1 = '50000000-0000-4000-8000-000000000001';

type ReservedRow = {
  productId: string;
  variantId: string | null;
  _sum: { quantity: number | null };
};

function makeService(options: {
  chargeError: unknown;
  sellable?: Record<string, number | null>;
  reserved?: ReservedRow[];
}) {
  const journal = {
    charge: jest.fn().mockRejectedValue(options.chargeError),
    lockSellable: jest.fn(
      (productId: string, variantId: string | null): Promise<number | null> =>
        Promise.resolve(
          (options.sellable ?? {})[`${productId}:${variantId ?? ''}`] ?? null,
        ),
    ),
  };
  const groupBy = jest.fn().mockResolvedValue(options.reserved ?? []);
  const tenantPrisma = {
    getClient: () => ({
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Cajera' }) },
      backorder: { groupBy },
    }),
    getTenantId: () => 'tenant-1',
  };
  const outbox = { publish: jest.fn() };
  const service = new SaleStockService(
    journal as unknown as StockJournalWriter,
    tenantPrisma as unknown as TenantPrismaService,
    outbox as unknown as OutboxWriterService,
    {} as IStockAlertStateRepository,
  );
  return { service, journal, groupBy, outbox };
}

const shortage = () => new InsufficientStockError('PRODUCT', P1, 2, 5);

const counterCharge = (
  service: SaleStockService,
  items = [{ productId: P1, quantity: 5 }],
  reservedAware = true,
) =>
  service.charge({
    saleId: 'sale-1',
    items,
    actor: { kind: 'user', userId: CASHIER },
    reservedAware,
  });

describe('SaleStockService.charge — STOCK_RESERVED_FOR_BACKORDER (counter)', () => {
  it('answers STOCK_RESERVED_FOR_BACKORDER {available, reserved} when quantity + reserved covers the failing line', async () => {
    const { service } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 2 },
      reserved: [{ productId: P1, variantId: null, _sum: { quantity: 3 } }],
    });

    const result = counterCharge(service);

    await expect(result).rejects.toBeInstanceOf(StockReservedForBackorderError);
    await expect(result).rejects.toMatchObject({
      code: 'STOCK_RESERVED_FOR_BACKORDER',
      message: 'STOCK_RESERVED_FOR_BACKORDER',
      details: { available: 2, reserved: 3 },
    });
  });

  it('keeps STOCK_INSUFFICIENT_AT_CONFIRM when the reserved units would not cover the line', async () => {
    const { service } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 2 },
      reserved: [{ productId: P1, variantId: null, _sum: { quantity: 2 } }],
    });

    await expect(counterCharge(service)).rejects.toMatchObject({
      code: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
  });

  it('keeps STOCK_INSUFFICIENT_AT_CONFIRM when nothing is reserved (plain insufficient stock)', async () => {
    const { service } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 2 },
      reserved: [],
    });

    const result = counterCharge(service);

    await expect(result).rejects.not.toBeInstanceOf(
      StockReservedForBackorderError,
    );
    await expect(result).rejects.toMatchObject({
      code: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
  });

  it('is exactly as before for a bot checkout: no reserved read, no mapping', async () => {
    const { service, groupBy, journal } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 2 },
      reserved: [{ productId: P1, variantId: null, _sum: { quantity: 9 } }],
    });

    await expect(
      counterCharge(service, undefined, false),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT_AT_CONFIRM' });
    expect(groupBy).not.toHaveBeenCalled();
    expect(journal.lockSellable).not.toHaveBeenCalled();
  });

  it('judges the FIRST failing line of the cart (variant line, one batched reserved read)', async () => {
    const { service, groupBy } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 10, [`${P2}:${V1}`]: 1 },
      reserved: [
        { productId: P1, variantId: null, _sum: { quantity: 50 } },
        { productId: P2, variantId: V1, _sum: { quantity: 4 } },
      ],
    });

    const result = counterCharge(service, [
      { productId: P1, quantity: 5 }, // covered by sellable: not the failing line
      { productId: P2, variantId: V1, quantity: 5 },
    ]);

    await expect(result).rejects.toMatchObject({
      code: 'STOCK_RESERVED_FOR_BACKORDER',
      details: { available: 1, reserved: 4 },
    });
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('a failing line not covered by its own reservations stays a plain shortage even if another line has reserved units', async () => {
    const { service } = makeService({
      chargeError: shortage(),
      sellable: { [`${P1}:`]: 0, [`${P2}:`]: 1 },
      reserved: [
        { productId: P1, variantId: null, _sum: { quantity: 1 } }, // 0 + 1 < 5
        { productId: P2, variantId: null, _sum: { quantity: 20 } },
      ],
    });

    await expect(
      counterCharge(service, [
        { productId: P1, quantity: 5 },
        { productId: P2, quantity: 5 },
      ]),
    ).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT_AT_CONFIRM' });
  });

  it('a missing bucket is never explained by reservations', async () => {
    const { service, groupBy } = makeService({
      chargeError: new StockBucketNotFoundError('PRODUCT', P1),
    });

    await expect(counterCharge(service)).rejects.toMatchObject({
      code: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
    expect(groupBy).not.toHaveBeenCalled();
  });
});
