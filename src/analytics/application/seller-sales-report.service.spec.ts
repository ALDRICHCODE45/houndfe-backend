/**
 * seller-sales-report / v1 service tests: exact delegation, frozen contract
 * composition, bounded-summary derivation, and adversarial row/sum validation.
 */
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  SELLER_SALES_REPORT_CONTRACT_ERROR,
  type SellerSalesReportCanceledRow,
  type SellerSalesReportConfirmedRow,
  type SellerSalesReportResult,
  type SellerSalesReportTopProduct,
} from '../domain/seller-sales-report.repository';
import { SellerSalesReportService } from './seller-sales-report.service';

const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'tenant-1';
const FROM = '2026-01-01';
const TO = '2026-02-01';
const at = (iso: string): Date => new Date(iso);

const confirmed = (
  overrides: Record<string, unknown> = {},
): SellerSalesReportConfirmedRow =>
  ({
    id: 'sale-1',
    folio: 'A-1',
    confirmedAt: at('2026-01-05T18:30:00.000Z'),
    totalCents: 10_000,
    paidCents: 4_000,
    debtCents: 6_000,
    paymentStatus: 'PARTIAL',
    localDate: '2026-01-05',
    customer: { id: 'cust-1', name: 'Ana López' },
    ...overrides,
  }) as unknown as SellerSalesReportConfirmedRow;

const canceled = (
  overrides: Record<string, unknown> = {},
): SellerSalesReportCanceledRow =>
  ({
    id: 'sale-2',
    folio: null,
    confirmedAt: at('2026-01-02T10:00:00.000Z'),
    canceledAt: at('2026-01-03T10:00:00.000Z'),
    totalCents: 5_000,
    customer: null,
    ...overrides,
  }) as unknown as SellerSalesReportCanceledRow;

const topProduct = (overrides: Record<string, unknown> = {}) =>
  ({
    productId: 'prod-1',
    variantId: null,
    productName: 'Croquetas',
    variantName: null,
    quantity: 3,
    netSalesCents: 9_000,
    ...overrides,
  }) as unknown as SellerSalesReportTopProduct;

/** Every local day of January 2026 with zero sales except the overrides. */
const januaryDays = (
  overrides: Record<string, { saleCount: number; netSalesCents: number }> = {},
) =>
  Array.from({ length: 31 }, (_, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`;
    return { date, ...(overrides[date] ?? { saleCount: 0, netSalesCents: 0 }) };
  });

const snapshot = (
  overrides: Partial<SellerSalesReportResult> = {},
): SellerSalesReportResult => ({
  tenantId: TENANT,
  seller: { id: SELLER_ID, name: 'Vendedor Uno' },
  confirmed: [confirmed()],
  canceled: [canceled()],
  rowCount: 2,
  topProducts: [topProduct()],
  previousPeriod: {
    from: '2025-12-01',
    to: FROM,
    saleCount: 2,
    netSalesCents: 5_000,
  },
  ...overrides,
});

const makeService = (result: SellerSalesReportResult) => {
  const findBySeller = jest.fn(() => Promise.resolve(result));
  return {
    service: new SellerSalesReportService({ findBySeller }),
    findBySeller,
  };
};

describe('SellerSalesReportService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('delegates once with the seller id and normalized range', async () => {
    const { service, findBySeller } = makeService(snapshot());
    await service.getSellerReport(SELLER_ID, { from: FROM, to: TO });
    expect(findBySeller).toHaveBeenCalledTimes(1);
    expect(findBySeller).toHaveBeenCalledWith(SELLER_ID, {
      from: FROM,
      to: TO,
    });
  });

  it('composes the frozen contract exactly', async () => {
    const { service } = makeService(snapshot());
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(result).toEqual({
      seller: { id: SELLER_ID, name: 'Vendedor Uno' },
      tenantId: TENANT,
      timeZone: ANALYTICS_TIME_ZONE,
      from: FROM,
      to: TO,
      generatedAt: '2026-03-01T12:00:00.000Z',
      attribution: 'CURRENT_SELLER',
      balances: 'CURRENT',
      rowLimit: 1000,
      rowCount: 2,
      confirmed: {
        dateBasis: 'confirmedAt',
        summary: {
          saleCount: 1,
          netSalesCents: 10_000,
          collectedCents: 4_000,
          outstandingDebtCents: 6_000,
          averageTicketCents: 10_000,
        },
        rows: [
          {
            id: 'sale-1',
            folio: 'A-1',
            confirmedAt: '2026-01-05T18:30:00.000Z',
            totalCents: 10_000,
            paidCents: 4_000,
            debtCents: 6_000,
            paymentStatus: 'PARTIAL',
            customer: { id: 'cust-1', name: 'Ana López' },
          },
        ],
      },
      canceled: {
        dateBasis: 'canceledAt',
        saleCount: 1,
        rows: [
          {
            id: 'sale-2',
            folio: null,
            confirmedAt: '2026-01-02T10:00:00.000Z',
            canceledAt: '2026-01-03T10:00:00.000Z',
            totalCents: 5_000,
            customer: null,
          },
        ],
      },
      topProducts: [
        {
          productId: 'prod-1',
          variantId: null,
          productName: 'Croquetas',
          variantName: null,
          quantity: 3,
          netSalesCents: 9_000,
        },
      ],
      dailyTotals: januaryDays({
        '2026-01-05': { saleCount: 1, netSalesCents: 10_000 },
      }),
      previousPeriod: {
        from: '2025-12-01',
        to: FROM,
        saleCount: 2,
        netSalesCents: 5_000,
      },
    });
  });

  it('zero-fills dailyTotals per local day and sums like confirmed.summary', async () => {
    const { service } = makeService(
      snapshot({
        confirmed: [
          confirmed({ id: 'a', localDate: '2026-01-01', totalCents: 100 }),
          confirmed({ id: 'b', localDate: '2026-01-01', totalCents: 250 }),
          confirmed({ id: 'c', localDate: '2026-01-03', totalCents: 7 }),
        ],
        canceled: [],
        rowCount: 3,
      }),
    );
    const result = await service.getSellerReport(SELLER_ID, {
      from: '2026-01-01',
      to: '2026-01-04',
    });
    expect(result.dailyTotals).toEqual([
      { date: '2026-01-01', saleCount: 2, netSalesCents: 350 },
      { date: '2026-01-02', saleCount: 0, netSalesCents: 0 },
      { date: '2026-01-03', saleCount: 1, netSalesCents: 7 },
    ]);
    const sum = result.dailyTotals.reduce((acc, d) => acc + d.netSalesCents, 0);
    expect(sum).toBe(result.confirmed.summary.netSalesCents);
  });

  it('spans month and leap-day boundaries in dailyTotals', async () => {
    const { service } = makeService(
      snapshot({
        confirmed: [],
        canceled: [],
        rowCount: 0,
        topProducts: [],
        previousPeriod: {
          from: '2028-02-26',
          to: '2028-02-28',
          saleCount: 0,
          netSalesCents: 0,
        },
      }),
    );
    const result = await service.getSellerReport(SELLER_ID, {
      from: '2028-02-28',
      to: '2028-03-02',
    });
    expect(result.dailyTotals.map((d) => d.date)).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('rejects a confirmed row whose local day falls outside [from, to)', async () => {
    const { service } = makeService(
      snapshot({
        confirmed: [confirmed({ localDate: '2026-02-01' })],
        canceled: [],
        rowCount: 1,
      }),
    );
    await expect(
      service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it('rejects malformed customer, top product and previous period blocks', async () => {
    for (const bad of [
      snapshot({
        confirmed: [confirmed({ customer: { id: 'c', name: 7 } })],
        canceled: [],
        rowCount: 1,
      }),
      snapshot({ canceled: [canceled({ customer: { id: 5, name: 'x' } })] }),
      snapshot({ topProducts: [topProduct({ quantity: -1 })] }),
      snapshot({ topProducts: [topProduct({ variantName: 3 })] }),
      snapshot({
        topProducts: Array.from({ length: 6 }, (_, i) =>
          topProduct({ productId: `p-${i}` }),
        ),
      }),
      snapshot({
        previousPeriod: {
          from: '2025-12-01',
          to: '2026-01-02',
          saleCount: 0,
          netSalesCents: 0,
        },
      }),
      snapshot({
        previousPeriod: {
          from: '2025-12-01',
          to: FROM,
          saleCount: 1.5,
          netSalesCents: 0,
        },
      }),
    ]) {
      const { service } = makeService(bad);
      await expect(
        service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
      ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
    }
  });

  it('derives the confirmed summary from the complete bounded rows only', async () => {
    const { service } = makeService(
      snapshot({
        confirmed: [
          confirmed({ totalCents: 10_000, paidCents: 4_000, debtCents: 6_000 }),
          confirmed({
            id: 'sale-3',
            totalCents: 1,
            paidCents: 1,
            debtCents: 0,
          }),
        ],
        canceled: [],
        rowCount: 2,
      }),
    );
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(result.confirmed.summary).toEqual({
      saleCount: 2,
      netSalesCents: 10_001,
      collectedCents: 4_001,
      outstandingDebtCents: 6_000,
      averageTicketCents: 5_001,
    });
  });

  it('returns the empty report surface when both sections are empty', async () => {
    const { service } = makeService(
      snapshot({ confirmed: [], canceled: [], rowCount: 0, topProducts: [] }),
    );
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(result.rowCount).toBe(0);
    expect(result.topProducts).toEqual([]);
    expect(result.dailyTotals).toEqual(januaryDays());
    expect(result.confirmed.summary).toEqual({
      saleCount: 0,
      netSalesCents: 0,
      collectedCents: 0,
      outstandingDebtCents: 0,
      averageTicketCents: 0,
    });
    expect(result.confirmed.rows).toEqual([]);
    expect(result.canceled).toEqual({
      dateBasis: 'canceledAt',
      saleCount: 0,
      rows: [],
    });
  });

  it('never projects contact data or currency fields', async () => {
    const { service } = makeService(snapshot());
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        'attribution',
        'balances',
        'canceled',
        'confirmed',
        'from',
        'generatedAt',
        'rowCount',
        'rowLimit',
        'seller',
        'tenantId',
        'timeZone',
        'to',
        'topProducts',
        'dailyTotals',
        'previousPeriod',
      ].sort(),
    );
    expect(Object.keys(result.confirmed.rows[0].customer!).sort()).toEqual([
      'id',
      'name',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /email|phone|address|currency|cashier|items/i,
    );
  });

  it('keeps generatedAt as generation time, never a row timestamp', async () => {
    const { service } = makeService(snapshot());
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(result.generatedAt).toBe('2026-03-01T12:00:00.000Z');
    expect(result.generatedAt).not.toBe(result.confirmed.rows[0].confirmedAt);
  });

  it('rejects a rowCount that does not match the materialized rows', async () => {
    const { service } = makeService(snapshot({ rowCount: 99 }));
    await expect(
      service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it('rejects a wrong seller identity in the snapshot', async () => {
    const { service } = makeService(
      snapshot({ seller: { id: 'other', name: 'X' } }),
    );
    await expect(
      service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it.each([
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['non-integer', 1.5],
    ['non-number', '1000'],
  ])('rejects a %s total cent value', async (_case, value) => {
    const { service } = makeService(
      snapshot({ confirmed: [confirmed({ totalCents: value })], rowCount: 1 }),
    );
    await expect(
      service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });

  it('rejects an invalid confirmedAt date and an invalid payment status', async () => {
    for (const bad of [
      { confirmedAt: new Date('nope') },
      { paymentStatus: 'REFUNDED' },
      { folio: 7 },
    ]) {
      const { service } = makeService(
        snapshot({
          confirmed: [confirmed(bad)],
          canceled: [],
          rowCount: 1,
        }),
      );
      await expect(
        service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
      ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
    }
  });

  it('rejects a canceled row with an invalid canceledAt or malformed confirmedAt', async () => {
    for (const bad of [
      { canceledAt: '2026-01-03' },
      { confirmedAt: 'not-a-date' },
    ]) {
      const { service } = makeService(
        snapshot({ confirmed: [], canceled: [canceled(bad)], rowCount: 1 }),
      );
      await expect(
        service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
      ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
    }
  });

  it('rejects a summary sum that overflows the safe integer range', async () => {
    const rows = [
      confirmed({ totalCents: Number.MAX_SAFE_INTEGER }),
      confirmed({ id: 'sale-3', totalCents: Number.MAX_SAFE_INTEGER }),
    ];
    const { service } = makeService(
      snapshot({ confirmed: rows, canceled: [], rowCount: 2 }),
    );
    await expect(
      service.getSellerReport(SELLER_ID, { from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: SELLER_SALES_REPORT_CONTRACT_ERROR });
  });
});
