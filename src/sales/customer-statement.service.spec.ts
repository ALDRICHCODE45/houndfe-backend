/**
 * sales-history-redesign S11 (+ S3 overdue rule) — CustomerStatementService
 * shaping over a mocked snapshot reader, with the SALES_CLOCK pinned.
 */
import { HttpException } from '@nestjs/common';
import { CustomerStatementService } from './customer-statement.service';
import type {
  CustomerStatementSnapshot,
  ICustomerStatementReader,
} from './domain/customer-statement.reader';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
// 2026-11-25 23:30 in Mexico City (UTC-6) = 2026-11-26T05:30Z: the local
// today is still 2026-11-25 although the UTC date already moved.
const NOW = new Date('2026-11-26T05:30:00.000Z');
const due = (day: string) => new Date(`${day}T00:00:00.000Z`);

function sale(
  over: Partial<CustomerStatementSnapshot['periodSales'][number]>,
): CustomerStatementSnapshot['periodSales'][number] {
  return {
    id: 'sale-x',
    folio: 'V-1',
    confirmedAt: new Date('2026-11-10T18:00:00.000Z'),
    localDate: '2026-11-10',
    totalCents: 10_000,
    paidCents: 10_000,
    openDebtCents: 0,
    dueDate: null,
    paymentStatus: 'PAID',
    ...over,
  };
}

function payment(
  over: Partial<CustomerStatementSnapshot['payments'][number]>,
): CustomerStatementSnapshot['payments'][number] {
  return {
    id: 'pay-x',
    saleId: 'sale-x',
    saleFolio: 'V-1',
    saleStatus: 'CONFIRMED',
    saleChangeDueCents: 0,
    paidAt: new Date('2026-11-10T18:00:00.000Z'),
    localDate: '2026-11-10',
    method: 'CASH',
    amountCents: 10_000,
    catalogName: null,
    ...over,
  };
}

function snapshot(
  over: Partial<CustomerStatementSnapshot> = {},
): CustomerStatementSnapshot {
  return {
    branchName: 'Sucursal Centro',
    customer: {
      id: CUSTOMER_ID,
      firstName: 'Rosa',
      lastName: 'Pérez',
      phoneCountryCode: '+52',
      phone: '5512345678',
      email: 'rosa@example.com',
      rfc: 'PERR800101AAA',
      businessName: 'Rosa SA',
    },
    periodSales: [],
    openDebtSales: [],
    payments: [],
    ...over,
  };
}

function build(snap: CustomerStatementSnapshot | null, timeZone?: string) {
  const reader: jest.Mocked<ICustomerStatementReader> = {
    read: jest.fn().mockResolvedValue(snap),
  };
  const config = { get: jest.fn().mockReturnValue(timeZone) };
  const service = new CustomerStatementService(
    reader,
    () => NOW,
    config as never,
  );
  return { service, reader };
}

const RANGE = { from: '2026-11-01', to: '2026-12-01' };

describe('CustomerStatementService', () => {
  it('reads once with the range and the business timezone (default Mexico City)', async () => {
    const { service, reader } = build(snapshot());

    const result = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledWith(CUSTOMER_ID, {
      ...RANGE,
      timeZone: 'America/Mexico_City',
    });
    expect(result).toMatchObject({
      timeZone: 'America/Mexico_City',
      from: '2026-11-01',
      to: '2026-12-01',
      today: '2026-11-25',
      generatedAt: NOW.toISOString(),
      branchName: 'Sucursal Centro',
    });
  });

  it('honours PROMOTIONS_BUSINESS_TIMEZONE for the read and the local today', async () => {
    const { service, reader } = build(snapshot(), 'UTC');

    const result = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(reader.read.mock.calls[0][1].timeZone).toBe('UTC');
    expect(result.today).toBe('2026-11-26');
  });

  it('unknown or foreign-tenant customer → 404 CUSTOMER_NOT_FOUND (code-only envelope)', async () => {
    const { service } = build(null);

    const error = await service
      .getStatement(CUSTOMER_ID, RANGE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect((error as HttpException).getResponse()).toEqual({
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('shapes the customer header: full name, phone with country code, optional fiscal data', async () => {
    const { service } = build(
      snapshot({
        customer: {
          id: CUSTOMER_ID,
          firstName: 'Luis',
          lastName: null,
          phoneCountryCode: '52',
          phone: '5511112222',
          email: null,
          rfc: '  ',
          businessName: null,
        },
      }),
    );

    const { customer } = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(customer).toEqual({
      id: CUSTOMER_ID,
      name: 'Luis',
      phone: '+52 5511112222',
      email: null,
      rfc: null,
      businessName: null,
    });
  });

  it('marks overdue with the S3 rule: due day (UTC date) before the local today and open debt > 0', async () => {
    const { service } = build(
      snapshot({
        periodSales: [
          // due yesterday, owes → overdue
          sale({
            id: 'a',
            paymentStatus: 'CREDIT',
            paidCents: 0,
            openDebtCents: 10_000,
            dueDate: due('2026-11-24'),
          }),
          // due on the local today (UTC already 26/11) → not overdue
          sale({
            id: 'b',
            paymentStatus: 'PARTIAL',
            paidCents: 4_000,
            openDebtCents: 6_000,
            dueDate: due('2026-11-25'),
          }),
          // default due date with time of day, earlier local day → overdue
          sale({
            id: 'c',
            paymentStatus: 'PARTIAL',
            paidCents: 9_000,
            openDebtCents: 1_000,
            dueDate: new Date('2026-11-20T17:45:00.000Z'),
          }),
          // past due day but settled → not overdue
          sale({ id: 'd', dueDate: due('2026-11-01') }),
          // owes without due date → not overdue
          sale({
            id: 'e',
            paymentStatus: 'CREDIT',
            paidCents: 0,
            openDebtCents: 10_000,
          }),
        ],
      }),
    );

    const { sales } = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(sales.map((s) => [s.id, s.overdue, s.dueDate])).toEqual([
      ['a', true, '2026-11-24'],
      ['b', false, '2026-11-25'],
      ['c', true, '2026-11-20'],
      ['d', false, '2026-11-01'],
      ['e', false, null],
    ]);
    expect(sales.map((s) => s.paymentStatusLabel)).toEqual([
      'Deuda',
      'Impaga',
      'Impaga',
      'Pagada',
      'Deuda',
    ]);
    expect(sales[0]).toMatchObject({
      folio: 'V-1',
      confirmedAt: '2026-11-10T18:00:00.000Z',
      localDate: '2026-11-10',
      totalCents: 10_000,
      paidCents: 0,
      openDebtCents: 10_000,
      paymentStatus: 'CREDIT',
    });
  });

  it('totals the period sales (count, total, paid, open debt, overdue part)', async () => {
    const { service } = build(
      snapshot({
        periodSales: [
          sale({ id: 'a', totalCents: 10_000, paidCents: 10_000 }),
          sale({
            id: 'b',
            totalCents: 5_000,
            paidCents: 1_000,
            openDebtCents: 4_000,
            paymentStatus: 'PARTIAL',
            dueDate: due('2026-11-02'),
          }),
          sale({
            id: 'c',
            totalCents: 2_500,
            paidCents: 0,
            openDebtCents: 2_500,
            paymentStatus: 'CREDIT',
            dueDate: due('2026-12-10'),
          }),
        ],
      }),
    );

    const { periodTotals } = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(periodTotals).toEqual({
      saleCount: 3,
      totalCents: 17_500,
      paidCents: 11_000,
      openDebtCents: 6_500,
      overdueSaleCount: 1,
      overdueDebtCents: 4_000,
    });
  });

  it('current debt covers every open-debt sale (older ones too) with its overdue part', async () => {
    const { service } = build(
      snapshot({
        openDebtSales: [
          { id: 'old', dueDate: due('2025-06-01'), openDebtCents: 30_000 },
          { id: 'today', dueDate: due('2026-11-25'), openDebtCents: 2_000 },
          { id: 'none', dueDate: null, openDebtCents: 500 },
          { id: 'late', dueDate: due('2026-11-24'), openDebtCents: 1_000 },
        ],
      }),
    );

    const { currentDebt } = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(currentDebt).toEqual({
      saleCount: 4,
      openDebtCents: 33_500,
      overdueSaleCount: 2,
      overdueDebtCents: 31_000,
    });
  });

  it('no debt and an empty period → zeros and empty lists', async () => {
    const { service } = build(snapshot());

    const result = await service.getStatement(CUSTOMER_ID, RANGE);

    expect(result.sales).toEqual([]);
    expect(result.payments).toEqual([]);
    expect(result.paymentsTotalCents).toBe(0);
    expect(result.currentDebt).toEqual({
      saleCount: 0,
      openDebtCents: 0,
      overdueSaleCount: 0,
      overdueDebtCents: 0,
    });
    expect(result.periodTotals.saleCount).toBe(0);
  });

  it('labels payment methods like the receipts (catalog name first) and marks canceled sales', async () => {
    const { service } = build(
      snapshot({
        payments: [
          payment({ id: 'p1', method: 'CASH' }),
          payment({ id: 'p2', method: 'CARD_CREDIT', amountCents: 2_000 }),
          payment({ id: 'p3', method: 'CARD_DEBIT', amountCents: 3_000 }),
          payment({
            id: 'p4',
            method: 'TRANSFER',
            amountCents: 4_000,
            saleStatus: 'CANCELED',
            saleFolio: 'V-9',
            saleId: 'sale-9',
          }),
          payment({
            id: 'p5',
            method: 'CARD_DEBIT',
            amountCents: 500,
            catalogName: 'Terminal BBVA',
          }),
        ],
      }),
    );

    const { payments, paymentsTotalCents } = await service.getStatement(
      CUSTOMER_ID,
      RANGE,
    );

    expect(payments.map((p) => p.methodLabel)).toEqual([
      'Efectivo',
      'Tarjeta de crédito',
      'Tarjeta de débito',
      'Transferencia',
      'Terminal BBVA',
    ]);
    expect(payments.map((p) => p.saleCanceled)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(payments[3]).toMatchObject({
      id: 'p4',
      saleId: 'sale-9',
      saleFolio: 'V-9',
      method: 'TRANSFER',
      amountCents: 4_000,
      paidAt: '2026-11-10T18:00:00.000Z',
      localDate: '2026-11-10',
    });
    expect(paymentsTotalCents).toBe(19_500);
  });

  it('reports cash net of the change given at the charge (tendered and change kept)', async () => {
    const { service } = build(
      snapshot({
        payments: [
          payment({
            id: 'card',
            method: 'CARD_DEBIT',
            amountCents: 3_000,
            saleChangeDueCents: 500,
          }),
          payment({
            id: 'cash',
            method: 'CASH',
            amountCents: 8_000,
            saleChangeDueCents: 500,
          }),
        ],
      }),
    );

    const { payments, paymentsTotalCents } = await service.getStatement(
      CUSTOMER_ID,
      RANGE,
    );

    expect(
      payments.map((p) => [
        p.id,
        p.amountCents,
        p.tenderedCents,
        p.changeCents,
      ]),
    ).toEqual([
      ['card', 3_000, 3_000, 0],
      ['cash', 7_500, 8_000, 500],
    ]);
    expect(paymentsTotalCents).toBe(10_500);
  });
});
