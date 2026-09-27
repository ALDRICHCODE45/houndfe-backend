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
    ...overrides,
  }) as unknown as SellerSalesReportCanceledRow;

const snapshot = (
  overrides: Partial<SellerSalesReportResult> = {},
): SellerSalesReportResult => ({
  tenantId: TENANT,
  seller: { id: SELLER_ID, name: 'Vendedor Uno' },
  confirmed: [confirmed()],
  canceled: [canceled()],
  rowCount: 2,
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
          },
        ],
      },
    });
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
      snapshot({ confirmed: [], canceled: [], rowCount: 0 }),
    );
    const result = await service.getSellerReport(SELLER_ID, {
      from: FROM,
      to: TO,
    });
    expect(result.rowCount).toBe(0);
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

  it('never projects PII or currency fields', async () => {
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
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /customer|email|phone|address|currency|cashier|items/i,
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
