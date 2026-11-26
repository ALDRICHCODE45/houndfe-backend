/**
 * customers-listing T4 (S4, contract §6.2, §2.1) — the KPI strip service:
 * one overdue cut-off per request from the sales clock and the business
 * timezone (the `GET /sales` rule), the shared §2.1 mapping, and the
 * code-only `404 CUSTOMER_NOT_FOUND`.
 */
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CustomerSalesMetricsRecord } from '../customers/listing/customer-sales-metrics.sql';
import type { ICustomerSalesSummaryReader } from './customer-sales-summary.reader';
import { CustomerSalesSummaryService } from './customer-sales-summary.service';

const CUSTOMER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
/** 23:59 local (Mexico City, UTC-6) on 26/11 → cut-off 2026-11-26T00:00Z. */
const LATE_26 = new Date('2026-11-27T05:59:00.000Z');
/** 00:00 local on 27/11 → cut-off 2026-11-27T00:00Z. */
const MIDNIGHT_27 = new Date('2026-11-27T06:00:00.000Z');

const EMPTY: CustomerSalesMetricsRecord = {
  salesCount: 0,
  totalSoldCents: 0n,
  openDebtCents: 0n,
  overdueCount: 0,
  overdueDebtCents: 0n,
  oldestOverdueDueDate: null,
  lastPurchaseAt: null,
  averageTicketCents: null,
};

function harness(
  record: CustomerSalesMetricsRecord | null,
  opts: { now?: Date; timeZone?: string } = {},
) {
  const read = jest
    .fn<
      ReturnType<ICustomerSalesSummaryReader['read']>,
      Parameters<ICustomerSalesSummaryReader['read']>
    >()
    .mockResolvedValue(record);
  const reader: ICustomerSalesSummaryReader = { read };
  const config = {
    get: (key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? opts.timeZone : undefined,
  } as unknown as ConfigService;
  const service = new CustomerSalesSummaryService(
    reader,
    config,
    () => opts.now ?? LATE_26,
  );
  return { service, read };
}

describe('CustomerSalesSummaryService', () => {
  it('maps the shared metrics row into { customerId, metrics } (§2.1)', async () => {
    const { service } = harness({
      salesCount: 3,
      totalSoldCents: 10001n,
      openDebtCents: 4500n,
      overdueCount: 1,
      overdueDebtCents: 3000n,
      oldestOverdueDueDate: new Date('2026-11-01T00:00:00.000Z'),
      lastPurchaseAt: new Date('2026-11-20T19:31:02.000Z'),
      averageTicketCents: 3334n,
    });

    await expect(service.summary(CUSTOMER_ID)).resolves.toEqual({
      customerId: CUSTOMER_ID,
      metrics: {
        openDebtCents: 4500,
        overdueDebtCents: 3000,
        overdueCount: 1,
        oldestOverdueDueDate: '2026-11-01',
        salesCount: 3,
        totalSoldCents: 10001,
        averageTicketCents: 3334,
        lastPurchaseAt: '2026-11-20T19:31:02.000Z',
      },
    });
  });

  it('a customer without sales reads counts/sums 0 and dates/average null', async () => {
    const { service } = harness(EMPTY);
    const { metrics } = await service.summary(CUSTOMER_ID);
    expect(metrics).toEqual({
      openDebtCents: 0,
      overdueDebtCents: 0,
      overdueCount: 0,
      oldestOverdueDueDate: null,
      salesCount: 0,
      totalSoldCents: 0,
      averageTicketCents: null,
      lastPurchaseAt: null,
    });
  });

  it.each([
    ['23:59 local on 26/11', LATE_26, '2026-11-26T00:00:00.000Z'],
    ['00:00 local on 27/11', MIDNIGHT_27, '2026-11-27T00:00:00.000Z'],
  ])(
    'passes the GET /sales overdue cut-off (%s, default Mexico City)',
    async (_label, now, cutoff) => {
      const { service, read } = harness(EMPTY, { now });
      await service.summary(CUSTOMER_ID);
      expect(read).toHaveBeenCalledWith(CUSTOMER_ID, new Date(cutoff));
    },
  );

  it('honours PROMOTIONS_BUSINESS_TIMEZONE', async () => {
    // 05:59Z on 27/11 is already 27/11 in UTC.
    const { service, read } = harness(EMPTY, { timeZone: 'UTC' });
    await service.summary(CUSTOMER_ID);
    expect(read).toHaveBeenCalledWith(
      CUSTOMER_ID,
      new Date('2026-11-27T00:00:00.000Z'),
    );
  });

  it('unknown or foreign-tenant customer → code-only 404 CUSTOMER_NOT_FOUND', async () => {
    const { service } = harness(null);
    const error = await service.summary(CUSTOMER_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect((error as HttpException).getResponse()).toEqual({
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    });
  });
});
