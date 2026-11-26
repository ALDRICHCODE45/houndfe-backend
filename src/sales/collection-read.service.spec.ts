/**
 * customer-collection / T3 (S5) — `CollectionReadService` shaping of
 * `GET /collections/:id` from the raw reader record (contract v1 §6, §7).
 */
import { HttpException } from '@nestjs/common';
import { CollectionReadService } from './collection-read.service';
import type {
  CollectionRecord,
  ICollectionReader,
} from './domain/collection-reader';

const CREATED_AT = new Date('2026-11-25T18:00:00.000Z');

function record(over: Partial<CollectionRecord> = {}): CollectionRecord {
  return {
    id: 'col-1',
    createdAt: CREATED_AT,
    customer: { id: 'cus-1', name: 'Ana López' },
    branchName: 'Sucursal Centro',
    cashierName: 'Cajera Uno',
    tenderedCents: 1000,
    appliedCents: 900,
    changeDueCents: 100,
    tendersJson: [
      {
        method: 'card_debit',
        amountCents: 600,
        catalog: { paymentMethodId: 'pm-1', name: 'BBVA', subtitle: 'Débito' },
      },
      { method: 'cash', amountCents: 400, catalog: null },
    ],
    // Sale ids chosen so the Q1 order differs from the record order.
    sales: [
      {
        saleId: 'sale-c',
        folio: 'V-3',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-10-03T15:00:00.000Z'),
        dueDate: null,
        totalCents: 400,
        paidThroughCents: 100,
      },
      {
        saleId: 'sale-b',
        folio: 'V-2',
        status: 'CANCELED',
        confirmedAt: new Date('2026-10-01T15:00:00.000Z'),
        dueDate: new Date('2026-12-10T00:00:00.000Z'),
        totalCents: 700,
        paidThroughCents: 700,
      },
      {
        saleId: 'sale-a',
        folio: 'V-1',
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-10-05T15:00:00.000Z'),
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        totalCents: 300,
        paidThroughCents: 300,
      },
    ],
    payments: [
      // sale-b: cash part listed first on purpose (cash is consumed last).
      {
        id: 'p-b2',
        saleId: 'sale-b',
        method: 'CASH',
        amountCents: 200,
        catalogPaymentMethodId: null,
      },
      {
        id: 'p-b1',
        saleId: 'sale-b',
        method: 'CARD_DEBIT',
        amountCents: 300,
        catalogPaymentMethodId: 'pm-1',
      },
      {
        id: 'p-a1',
        saleId: 'sale-a',
        method: 'CARD_DEBIT',
        amountCents: 300,
        catalogPaymentMethodId: 'pm-1',
      },
      {
        id: 'p-c1',
        saleId: 'sale-c',
        method: 'CASH',
        amountCents: 100,
        catalogPaymentMethodId: null,
      },
    ],
    customerDebtAfterCents: 300,
    ...over,
  };
}

function serviceWith(found: CollectionRecord | null) {
  const reader: ICollectionReader = {
    findCollection: jest.fn().mockResolvedValue(found),
  };
  return { service: new CollectionReadService(reader), reader };
}

describe('CollectionReadService', () => {
  it('shapes the POST §6 response from the record, sales in Q1 order', async () => {
    const { service } = serviceWith(record());

    const body = await service.getCollection('col-1');

    expect(body).toEqual({
      collectionId: 'col-1',
      customer: { id: 'cus-1', name: 'Ana López' },
      createdAt: CREATED_AT.toISOString(),
      tenderedCents: 1000,
      appliedCents: 900,
      changeDueCents: 100,
      payments: [
        {
          method: 'card_debit',
          amountCents: 600,
          catalog: {
            paymentMethodId: 'pm-1',
            name: 'BBVA',
            subtitle: 'Débito',
          },
        },
        { method: 'cash', amountCents: 400, catalog: null },
      ],
      sales: [
        {
          saleId: 'sale-a',
          folio: 'V-1',
          confirmedAt: '2026-10-05T15:00:00.000Z',
          dueDate: '2026-11-01T00:00:00.000Z',
          // Debt before = 0 after + 300 applied, due before the collection day.
          overdue: true,
          appliedCents: 300,
          paidCents: 300,
          debtCents: 0,
          paymentStatus: 'PAID',
          paymentIds: ['p-a1'],
          saleStatus: 'CONFIRMED',
        },
        {
          saleId: 'sale-b',
          folio: 'V-2',
          confirmedAt: '2026-10-01T15:00:00.000Z',
          dueDate: '2026-12-10T00:00:00.000Z',
          overdue: false,
          appliedCents: 500,
          paidCents: 700,
          debtCents: 0,
          paymentStatus: 'PAID',
          // Tender consumption order: the card part before the cash part.
          paymentIds: ['p-b1', 'p-b2'],
          saleStatus: 'CANCELED',
        },
        {
          saleId: 'sale-c',
          folio: 'V-3',
          confirmedAt: '2026-10-03T15:00:00.000Z',
          dueDate: null,
          overdue: false,
          appliedCents: 100,
          paidCents: 100,
          debtCents: 300,
          paymentStatus: 'PARTIAL',
          paymentIds: ['p-c1'],
          saleStatus: 'CONFIRMED',
        },
      ],
      remainingCustomerDebtCents: 300,
    });
  });

  it('computes overdue with the collection day as "today" and the debt BEFORE it', async () => {
    // Due 2026-11-25 = the collection day itself → not overdue yet; a sale
    // fully paid by the collection was still overdue before it.
    const { service } = serviceWith(
      record({
        sales: [
          {
            saleId: 'sale-a',
            folio: 'V-1',
            status: 'CONFIRMED',
            confirmedAt: null,
            dueDate: new Date('2026-11-25T00:00:00.000Z'),
            totalCents: 300,
            paidThroughCents: 300,
          },
          {
            saleId: 'sale-b',
            folio: 'V-2',
            status: 'CONFIRMED',
            confirmedAt: null,
            dueDate: new Date('2026-11-24T00:00:00.000Z'),
            totalCents: 700,
            paidThroughCents: 700,
          },
          {
            saleId: 'sale-c',
            folio: null,
            status: 'CONFIRMED',
            confirmedAt: null,
            dueDate: null,
            totalCents: 400,
            paidThroughCents: 100,
          },
        ],
      }),
    );

    const body = await service.getCollection('col-1');
    const overdue = Object.fromEntries(
      body.sales.map((sale) => [sale.saleId, sale.overdue]),
    );

    expect(overdue).toEqual({
      'sale-a': false,
      'sale-b': true,
      'sale-c': false,
    });
  });

  it('answers customer null and remaining debt null once the customer is gone', async () => {
    const { service } = serviceWith(
      record({ customer: null, customerDebtAfterCents: null }),
    );

    const body = await service.getCollection('col-1');

    expect(body.customer).toBeNull();
    expect(body.remainingCustomerDebtCents).toBeNull();
  });

  it('unknown or foreign collection → 404 COLLECTION_NOT_FOUND, code-only envelope', async () => {
    const { service } = serviceWith(null);

    const error = await service.getCollection('nope').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect((error as HttpException).getResponse()).toEqual({
      statusCode: 404,
      error: 'COLLECTION_NOT_FOUND',
      message: 'COLLECTION_NOT_FOUND',
    });
  });

  it.each([
    ['not an array', { method: 'cash' }],
    ['unknown method', [{ method: 'credit', amountCents: 1000, catalog: null }]],
    ['non-integer amount', [{ method: 'cash', amountCents: 9.5, catalog: null }]],
    [
      'catalog without name',
      [{ method: 'cash', amountCents: 1000, catalog: { paymentMethodId: 'x' } }],
    ],
    [
      'sum differs from tenderedCents',
      [{ method: 'cash', amountCents: 999, catalog: null }],
    ],
  ])('rejects a stored tendersJson that is invalid (%s)', async (_, tenders) => {
    const { service } = serviceWith(record({ tendersJson: tenders }));

    await expect(service.getCollection('col-1')).rejects.toThrow(
      'COLLECTION_TENDERS_INVALID',
    );
  });

  it('getReceipt adds branch and cashier to the read shape', async () => {
    const { service } = serviceWith(record({ cashierName: null }));

    const receipt = await service.getReceipt('col-1');

    expect(receipt.branchName).toBe('Sucursal Centro');
    expect(receipt.cashierName).toBeNull();
    expect(receipt.collection.collectionId).toBe('col-1');
  });
});
