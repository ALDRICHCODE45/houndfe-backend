/**
 * sales-history-redesign / T1 (contract §1, §3, §5.2, §7) — GET /sales
 * product preview, average ticket and overdue blocks, plus the customer
 * monthly totals, through `SalesService`'s public methods.
 */
import { HttpException } from '@nestjs/common';
import { SalesService } from './sales.service';
import type { ISaleRepository } from './domain/sale.repository';

const CUSTOMER = 'f9d2f368-10be-4f4b-a3cc-0e67735f7f26';
const PET = '9f6a0d2c-6b3b-4d86-a1d4-0e3b2f6a7c11';
// 05:00Z on 2026-11-25 is 23:00 of 2026-11-24 in America/Mexico_City (UTC-6).
// The due day of a sale is the UTC calendar date of `dueDate` (what the POS
// shows), so the overdue cut-off is 00:00Z of the LOCAL today: a sale due on
// 2026-11-24 (stored 2026-11-24T00:00Z) is not overdue yet.
const NOW = new Date('2026-11-25T05:00:00.000Z');
const CUTOFF = new Date('2026-11-24T00:00:00.000Z');

const ROW = {
  id: 'sale-1',
  folio: 'V-0001',
  status: 'CONFIRMED',
  channel: 'POS',
  cancelReason: null,
  paymentStatus: 'CREDIT',
  deliveryStatus: 'DELIVERED',
  totalCents: 1500,
  debtCents: 1500,
  confirmedAt: new Date('2026-11-01T10:00:00.000Z'),
  dueDate: '2026-11-16T10:00:00.000Z',
  customer: { id: CUSTOMER, name: 'Ana' },
  cashier: { id: 'u1', name: 'Cajero' },
  seller: null,
  paymentMethods: [],
  shippingAddress: null,
  hold: null,
  itemsPreview: [
    { productName: 'Croquetas', variantName: '2 kg', quantity: 2 },
    { productName: 'Collar', variantName: null, quantity: 1 },
  ],
  itemsCount: 2,
};

function makeRepo() {
  return {
    findManyConfirmed: jest.fn().mockResolvedValue([ROW]),
    aggregateManyConfirmed: jest
      .fn()
      .mockResolvedValue({ count: 1, totalCents: 1500, debtCents: 1500 }),
    aggregateSummaryConfirmed: jest.fn().mockResolvedValue({
      salesCount: 2,
      totalSoldCents: 1001,
      outstandingDebtCents: 1500,
    }),
    groupByPaymentStatusConfirmed: jest.fn().mockResolvedValue([
      { paymentStatus: 'PAID', _count: { _all: 1 } },
      { paymentStatus: 'CREDIT', _count: { _all: 1 } },
    ]),
    countNotDeliveredConfirmed: jest.fn().mockResolvedValue(0),
    aggregateOverdueConfirmed: jest.fn().mockResolvedValue({
      count: 1,
      debtCents: 1500,
      // Rendered by its UTC calendar date (Nov 2), never shifted to local.
      oldestDueDate: new Date('2026-11-02T04:00:00.000Z'),
    }),
    findMonthlyConfirmedByCustomer: jest.fn().mockResolvedValue([]),
  };
}

function makeService(
  repo: ReturnType<typeof makeRepo>,
  opts: { timeZone?: string; customerExists?: boolean; now?: Date } = {},
) {
  const findCustomer = jest
    .fn()
    .mockResolvedValue(opts.customerExists === false ? null : { id: CUSTOMER });
  const findPet = jest.fn().mockResolvedValue({ id: PET });
  const tenantPrisma = {
    getTenantId: () => 'tenant-1',
    getClient: () => ({
      customer: { findFirst: findCustomer },
      customerPet: { findFirst: findPet },
    }),
  };
  const config = {
    get: (key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? opts.timeZone : undefined,
  };
  const service = new SalesService(
    repo as unknown as ISaleRepository,
    {} as never,
    { emit: jest.fn() } as never,
    {} as never,
    tenantPrisma as never,
    undefined,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    config as never,
    () => opts.now ?? NOW,
  );
  return { service, findCustomer };
}

describe('SalesService — sales history redesign (T1)', () => {
  describe('GET /sales (listSales)', () => {
    it('S1 — rows reach `data` unchanged, with their items preview and count', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo);

      const result = await service.listSales({ page: 1, limit: 20 } as never);

      expect(result.data).toEqual([ROW]);
      // Envelope keys are unchanged apart from the new nested keys.
      expect(Object.keys(result).sort()).toEqual(
        ['counts', 'data', 'filterSummary', 'pagination', 'summary'].sort(),
      );
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(result.filterSummary).toEqual({
        count: 1,
        totalCents: 1500,
        debtCents: 1500,
      });
    });

    it('S2/S3 — summary and counts carry the average ticket and the overdue block', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo);

      const result = await service.listSales({ customerId: [CUSTOMER] } as never);

      expect(result.counts).toEqual({
        all: 2,
        pendingPayments: 1,
        notDelivered: 0,
        overdue: 1,
      });
      expect(result.summary).toEqual({
        salesCount: 2,
        totalSoldCents: 1001,
        outstandingDebtCents: 1500,
        averageTicketCents: 501, // 500.5 → 501 (half up)
        overdueDebtCents: 1500,
        oldestOverdueDueDate: '2026-11-02',
      });
      expect(result.summary.salesCount).toBe(result.counts.all);
    });

    it('S2 — the average ticket is 0 when no sale matches, and rounds down below .5', async () => {
      const repo = makeRepo();
      repo.aggregateSummaryConfirmed.mockResolvedValueOnce({
        salesCount: 0,
        totalSoldCents: 0,
        outstandingDebtCents: 0,
      });
      repo.aggregateOverdueConfirmed.mockResolvedValueOnce({
        count: 0,
        debtCents: 0,
        oldestDueDate: null,
      });
      const { service } = makeService(repo);
      const empty = await service.listSales({} as never);
      expect(empty.summary.averageTicketCents).toBe(0);
      expect(empty.summary.oldestOverdueDueDate).toBeNull();
      expect(empty.counts.overdue).toBe(0);

      repo.aggregateSummaryConfirmed.mockResolvedValueOnce({
        salesCount: 3,
        totalSoldCents: 1000,
        outstandingDebtCents: 0,
      });
      const third = await service.listSales({} as never);
      expect(third.summary.averageTicketCents).toBe(333);
    });

    it('S3 — the overdue aggregate runs over the base filters with 00:00Z of the local today (Mexico City)', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo);

      await service.listSales({
        customerId: [CUSTOMER],
        paymentStatus: ['CREDIT'],
        deliveryStatus: ['PENDING'],
        overdue: true,
      } as never);

      expect(repo.aggregateOverdueConfirmed).toHaveBeenCalledTimes(1);
      const [baseFilters, cutoff] = repo.aggregateOverdueConfirmed.mock
        .calls[0] as [Record<string, unknown>, Date];
      expect(cutoff).toEqual(CUTOFF);
      expect(baseFilters).toEqual(
        repo.aggregateSummaryConfirmed.mock.calls[0][0],
      );
      expect(baseFilters).toMatchObject({ customerId: [CUSTOMER] });
      for (const key of ['paymentStatus', 'deliveryStatus', 'overdueBefore']) {
        expect(baseFilters).not.toHaveProperty(key);
      }
    });

    it('S3 — the configured business timezone moves the cut-off', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo, { timeZone: 'UTC' });

      const result = await service.listSales({ overdue: true } as never);

      expect(repo.aggregateOverdueConfirmed.mock.calls[0][1]).toEqual(
        new Date('2026-11-25T00:00:00.000Z'),
      );
      expect(repo.findManyConfirmed.mock.calls[0][0].overdueBefore).toEqual(
        new Date('2026-11-25T00:00:00.000Z'),
      );
      // The oldest due date is its UTC calendar date in every zone.
      expect(result.summary.oldestOverdueDueDate).toBe('2026-11-02');
    });

    it('S3 — overdue=true narrows data/pagination/filterSummary only; summary and counts ignore it', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo);

      const unfiltered = await service.listSales({
        customerId: [CUSTOMER],
        petId: PET,
      } as never);
      repo.aggregateManyConfirmed.mockResolvedValueOnce({
        count: 0,
        totalCents: 0,
        debtCents: 0,
      });
      const filtered = await service.listSales({
        customerId: [CUSTOMER],
        petId: PET,
        overdue: true,
      } as never);

      const pageCall = repo.findManyConfirmed.mock.calls[1][0];
      expect(pageCall).toMatchObject({
        customerId: [CUSTOMER],
        petId: PET,
        overdueBefore: CUTOFF,
      });
      const { page, limit, sortBy, sortOrder, ...pageFilters } = pageCall;
      void [page, limit, sortBy, sortOrder];
      expect(repo.aggregateManyConfirmed.mock.calls[1][0]).toEqual(pageFilters);
      for (const call of [
        repo.aggregateSummaryConfirmed.mock.calls[1][0],
        repo.groupByPaymentStatusConfirmed.mock.calls[1][0],
        repo.countNotDeliveredConfirmed.mock.calls[1][0],
      ]) {
        expect(call).not.toHaveProperty('overdueBefore');
        expect(call).not.toHaveProperty('petId');
      }
      expect(filtered.pagination.total).toBe(0);
      expect(filtered.filterSummary.count).toBe(0);
      expect(filtered.summary).toEqual(unfiltered.summary);
      expect(filtered.counts).toEqual(unfiltered.counts);
    });

    it.each([
      ['absent', {}],
      ['false', { overdue: false }],
    ])('S3 — overdue %s applies no page filter', async (_label, extra) => {
      const repo = makeRepo();
      const { service } = makeService(repo);

      await service.listSales({ ...extra } as never);

      expect(
        repo.findManyConfirmed.mock.calls[0][0].overdueBefore,
      ).toBeUndefined();
      expect(
        repo.aggregateManyConfirmed.mock.calls[0][0].overdueBefore,
      ).toBeUndefined();
    });
  });

  describe('GET /customers/:customerId/sales-monthly (getCustomerSalesMonthly)', () => {
    it('S4 — one entry per month ending with the current local month, zero months included', async () => {
      const repo = makeRepo();
      repo.findMonthlyConfirmedByCustomer.mockResolvedValue([
        { month: '2026-01', saleCount: 2, totalCents: 3000 },
        { month: '2026-11', saleCount: 1, totalCents: 1250 },
      ]);
      const { service, findCustomer } = makeService(repo);

      const result = await service.getCustomerSalesMonthly(CUSTOMER, 12);

      expect(findCustomer).toHaveBeenCalledWith({
        where: { id: CUSTOMER, tenantId: 'tenant-1' },
        select: { id: true },
      });
      // Local "now" is still November 2026 (23:00 on Nov 24 in Mexico City).
      expect(repo.findMonthlyConfirmedByCustomer).toHaveBeenCalledWith({
        customerId: CUSTOMER,
        from: '2025-12-01',
        to: '2026-12-01',
        timeZone: 'America/Mexico_City',
      });
      expect(result.customerId).toBe(CUSTOMER);
      expect(result.timeZone).toBe('America/Mexico_City');
      expect(result.months.map((m) => m.month)).toEqual([
        '2025-12',
        '2026-01',
        '2026-02',
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06',
        '2026-07',
        '2026-08',
        '2026-09',
        '2026-10',
        '2026-11',
      ]);
      expect(result.months[0]).toEqual({
        month: '2025-12',
        saleCount: 0,
        totalCents: 0,
      });
      expect(result.months[1]).toEqual({
        month: '2026-01',
        saleCount: 2,
        totalCents: 3000,
      });
      expect(result.months[11]).toEqual({
        month: '2026-11',
        saleCount: 1,
        totalCents: 1250,
      });
    });

    it('S4 — the current month follows the business timezone across a year boundary', async () => {
      // 03:00Z on Jan 1 2027 is still Dec 31 2026 in Mexico City.
      const repo = makeRepo();
      const { service } = makeService(repo, {
        now: new Date('2027-01-01T03:00:00.000Z'),
      });

      const result = await service.getCustomerSalesMonthly(CUSTOMER, 2);

      expect(repo.findMonthlyConfirmedByCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ from: '2026-11-01', to: '2027-01-01' }),
      );
      expect(result.months).toEqual([
        { month: '2026-11', saleCount: 0, totalCents: 0 },
        { month: '2026-12', saleCount: 0, totalCents: 0 },
      ]);
    });

    it('S4 — an unknown (or foreign-tenant) customer is CUSTOMER_NOT_FOUND and nothing is aggregated', async () => {
      const repo = makeRepo();
      const { service } = makeService(repo, { customerExists: false });

      const error = await service
        .getCustomerSalesMonthly(CUSTOMER, 12)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(404);
      expect((error as HttpException).getResponse()).toEqual({
        statusCode: 404,
        error: 'CUSTOMER_NOT_FOUND',
        message: 'CUSTOMER_NOT_FOUND',
      });
      expect(repo.findMonthlyConfirmedByCustomer).not.toHaveBeenCalled();
    });
  });
});
