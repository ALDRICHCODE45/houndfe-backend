/**
 * customers-listing T2 (S5, contract §7, §7.1, §7.2) — shaping of the
 * customer payments feed over reader facts, plus the shared statement change
 * rule (`splitSaleChange`) the feed reuses.
 */
import { HttpException } from '@nestjs/common';
import { splitSaleChange } from './customer-statement.service';
import type {
  CustomerCollectionEventRecord,
  CustomerPaymentEventRecord,
  CustomerPaymentsPageRecord,
  ICustomerPaymentsReader,
} from './customer-payments.reader';
import { CustomerPaymentsService } from './customer-payments.service';
import type {
  CustomerCollectionEventDto,
  CustomerPaymentEventDto,
} from './dto/customer-payments.dto';

const CUSTOMER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const CASHIER = { id: 'user-1', name: 'María' };

describe('splitSaleChange (statement PDF change rule)', () => {
  const row = (
    saleId: string,
    method: string,
    amountCents: number,
    change: number,
  ) => ({
    saleId,
    method,
    amountCents,
    saleChangeDueCents: change,
  });

  it('takes the change from the CASH rows in payment order and gives non-cash rows 0', () => {
    expect(
      splitSaleChange([
        row('s1', 'CARD_DEBIT', 3000, 500),
        row('s1', 'CASH', 5000, 500),
        row('s1', 'TRANSFER', 1000, 500),
      ]),
    ).toEqual([0, 500, 0]);
  });

  it('spills change larger than the first cash row onto the next cash row', () => {
    expect(
      splitSaleChange([
        row('s1', 'CASH', 300, 800),
        row('s1', 'CARD_CREDIT', 1000, 800),
        row('s1', 'CASH', 2000, 800),
        row('s1', 'CASH', 2000, 800),
      ]),
    ).toEqual([300, 0, 500, 0]);
  });

  it('keeps one change budget per sale and ignores negative change', () => {
    expect(
      splitSaleChange([
        row('s1', 'CASH', 1000, 200),
        row('s2', 'CASH', 1000, 700),
        row('s1', 'CASH', 1000, 200),
        row('s3', 'CASH', 1000, -50),
      ]),
    ).toEqual([200, 700, 0, 0]);
  });
});

function collectionEvent(
  overrides: Partial<CustomerCollectionEventRecord> = {},
): CustomerCollectionEventRecord {
  return {
    kind: 'collection',
    collectionId: 'col-1',
    createdAt: new Date('2026-11-26T18:02:11.000Z'),
    tenderedCents: 100000,
    appliedCents: 90000,
    changeDueCents: 10000,
    tendersJson: [
      { method: 'card_debit', amountCents: 60000, catalog: null },
      {
        method: 'cash',
        amountCents: 40000,
        catalog: null,
      },
    ],
    cashier: CASHIER,
    sales: [
      {
        saleId: 'sale-b',
        folio: 'V-2',
        status: 'CANCELED',
        confirmedAt: new Date('2026-10-02T00:00:00.000Z'),
        dueDate: null,
        appliedCents: 30000,
      },
      {
        saleId: 'sale-a',
        folio: 'V-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-10-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        appliedCents: 60000,
      },
    ],
    ...overrides,
  };
}

function paymentEvent(
  overrides: Partial<CustomerPaymentEventRecord> = {},
): CustomerPaymentEventRecord {
  return {
    kind: 'payment',
    paymentId: 'pay-2',
    createdAt: new Date('2026-11-20T19:31:02.000Z'),
    method: 'CASH',
    metadataJson: null,
    reference: null,
    amountCents: 5000,
    cashier: { id: 'user-2', name: 'Luis' },
    sale: {
      id: 'sale-c',
      folio: 'V-3',
      status: 'CONFIRMED',
      totalCents: 7500,
      changeDueCents: 1500,
    },
    saleRows: [
      { id: 'pay-1', method: 'CASH', amountCents: 1000 },
      { id: 'pay-2', method: 'CASH', amountCents: 5000 },
      { id: 'pay-3', method: 'TRANSFER', amountCents: 3000 },
    ],
    ...overrides,
  };
}

function serviceWith(page: CustomerPaymentsPageRecord | null) {
  const read = jest.fn().mockResolvedValue(page);
  const reader: ICustomerPaymentsReader = { read };
  return { read, service: new CustomerPaymentsService(reader) };
}

describe('CustomerPaymentsService', () => {
  it('unknown or foreign customer → 404 CUSTOMER_NOT_FOUND with the code-only envelope', async () => {
    const { service } = serviceWith(null);

    const error = await service
      .list(CUSTOMER_ID, { page: 1, limit: 50 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect((error as HttpException).getResponse()).toEqual({
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('asks the reader for the page window and answers the GET /sales pagination object', async () => {
    const { read, service } = serviceWith({ total: 101, events: [] });

    const result = await service.list(CUSTOMER_ID, { page: 3, limit: 50 });

    expect(read).toHaveBeenCalledWith(CUSTOMER_ID, {
      offset: 100,
      limit: 50,
    });
    expect(result).toEqual({
      data: [],
      pagination: { page: 3, limit: 50, total: 101, totalPages: 3 },
    });
  });

  it('totalPages is 0 when the customer has no payments', async () => {
    const { service } = serviceWith({ total: 0, events: [] });

    await expect(
      service.list(CUSTOMER_ID, { page: 1, limit: 50 }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  });

  it('shapes a «Cobrar todo» event: applied amount, stored tenders, sales in the GET /collections/:id order, receipt path', async () => {
    const { service } = serviceWith({ total: 1, events: [collectionEvent()] });

    const { data } = await service.list(CUSTOMER_ID, { page: 1, limit: 50 });

    expect(data).toEqual<CustomerCollectionEventDto[]>([
      {
        kind: 'collection',
        eventId: 'col-1',
        occurredAt: '2026-11-26T18:02:11.000Z',
        amountCents: 90000,
        tenderedCents: 100000,
        changeDueCents: 10000,
        payments: [
          { method: 'card_debit', amountCents: 60000, catalog: null },
          { method: 'cash', amountCents: 40000, catalog: null },
        ],
        // Q1 order: dated due day first, then confirmedAt.
        sales: [
          {
            saleId: 'sale-a',
            folio: 'V-1',
            status: 'CONFIRMED',
            appliedCents: 60000,
          },
          {
            saleId: 'sale-b',
            folio: 'V-2',
            status: 'CANCELED',
            appliedCents: 30000,
          },
        ],
        cashier: CASHIER,
        receiptPath: '/collections/col-1/pdf',
      },
    ]);
  });

  it('a collection with corrupt stored tenders fails like GET /collections/:id', async () => {
    const { service } = serviceWith({
      total: 1,
      events: [
        collectionEvent({ tendersJson: [{ method: 'CASH', amountCents: 1 }] }),
      ],
    });

    await expect(
      service.list(CUSTOMER_ID, { page: 1, limit: 50 }),
    ).rejects.toThrow('COLLECTION_TENDERS_INVALID');
  });

  it('shapes a standalone payment: lowercase method, net of its statement change share, sale receipt path', async () => {
    const { service } = serviceWith({ total: 1, events: [paymentEvent()] });

    const { data } = await service.list(CUSTOMER_ID, { page: 1, limit: 50 });

    // Change 1500: pay-1 (1000 cash) takes 1000, pay-2 takes the other 500.
    expect(data).toEqual<CustomerPaymentEventDto[]>([
      {
        kind: 'payment',
        eventId: 'pay-2',
        occurredAt: '2026-11-20T19:31:02.000Z',
        method: 'cash',
        catalog: null,
        reference: null,
        amountCents: 4500,
        tenderedCents: 5000,
        changeCents: 500,
        sale: {
          id: 'sale-c',
          folio: 'V-3',
          status: 'CONFIRMED',
          totalCents: 7500,
        },
        cashier: { id: 'user-2', name: 'Luis' },
        receiptPath: '/sales/sale-c/pdf',
      },
    ]);
  });

  it.each([
    ['CARD_CREDIT', 'card_credit'],
    ['CARD_DEBIT', 'card_debit'],
    ['TRANSFER', 'transfer'],
  ])('maps %s to %s with no change', async (stored, method) => {
    const { service } = serviceWith({
      total: 1,
      events: [
        paymentEvent({
          paymentId: 'pay-3',
          method: stored,
          amountCents: 3000,
          reference: 'REF-9',
          saleRows: [{ id: 'pay-3', method: stored, amountCents: 3000 }],
        }),
      ],
    });

    const [event] = (await service.list(CUSTOMER_ID, { page: 1, limit: 50 }))
      .data as CustomerPaymentEventDto[];

    expect(event).toMatchObject({
      method,
      reference: 'REF-9',
      amountCents: 3000,
      tenderedCents: 3000,
      changeCents: 0,
    });
  });

  it('exposes a valid catalog snapshot and nulls an invalid one', async () => {
    const { service } = serviceWith({
      total: 3,
      events: [
        paymentEvent({
          paymentId: 'p-a',
          metadataJson: {
            catalog: {
              paymentMethodId: 'pm-1',
              name: 'Terminal BBVA',
              subtitle: 'Débito',
            },
          },
          saleRows: [{ id: 'p-a', method: 'CASH', amountCents: 5000 }],
        }),
        paymentEvent({
          paymentId: 'p-b',
          metadataJson: { catalog: { paymentMethodId: 'pm-2', name: 'Vales' } },
          saleRows: [{ id: 'p-b', method: 'CASH', amountCents: 5000 }],
        }),
        paymentEvent({
          paymentId: 'p-c',
          metadataJson: {
            catalog: { paymentMethodId: 7, name: 'x' },
            reference: 'r',
          },
          saleRows: [{ id: 'p-c', method: 'CASH', amountCents: 5000 }],
        }),
      ],
    });

    const data = (await service.list(CUSTOMER_ID, { page: 1, limit: 50 }))
      .data as CustomerPaymentEventDto[];

    expect(data.map((event) => event.catalog)).toEqual([
      { paymentMethodId: 'pm-1', name: 'Terminal BBVA', subtitle: 'Débito' },
      { paymentMethodId: 'pm-2', name: 'Vales' },
      null,
    ]);
  });

  it('flags a payment of a sale canceled later: status CANCELED, receiptPath null, amount still listed', async () => {
    const { service } = serviceWith({
      total: 1,
      events: [
        paymentEvent({
          cashier: null,
          sale: {
            id: 'sale-c',
            folio: 'V-3',
            status: 'CANCELED',
            totalCents: 7500,
            changeDueCents: 0,
          },
          saleRows: [{ id: 'pay-2', method: 'CASH', amountCents: 5000 }],
        }),
      ],
    });

    const [event] = (await service.list(CUSTOMER_ID, { page: 1, limit: 50 }))
      .data as CustomerPaymentEventDto[];

    expect(event).toMatchObject({
      sale: { status: 'CANCELED' },
      receiptPath: null,
      cashier: null,
      amountCents: 5000,
    });
  });

  it('keeps the reader order across kinds', async () => {
    const { service } = serviceWith({
      total: 2,
      events: [paymentEvent({ paymentId: 'pay-2' }), collectionEvent()],
    });

    const { data } = await service.list(CUSTOMER_ID, { page: 1, limit: 50 });

    expect(data.map((event) => [event.kind, event.eventId])).toEqual([
      ['payment', 'pay-2'],
      ['collection', 'col-1'],
    ]);
  });
});
