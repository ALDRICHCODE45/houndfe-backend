/**
 * `sourceDecisionId` in the payload of `backorder.reservation_expired` and
 * `backorder.cancelled_by_staff` (restock-backorder T4, chatbot request): after
 * an expiry or a staff cancel the bot reschedules by repeating
 * `POST /chatbot-api/backorders` with the same `sourceDecisionId`. Additive: the
 * existing members are untouched and the other item types do not carry it.
 */
import {
  enqueueBackorderCancelledByStaff,
  enqueueBackorderEtaUnavailable,
  enqueueBackorderEtaUpdated,
  enqueueBackorderReservationExpired,
  enqueueBackorderReservationLost,
  enqueueBackorderReservationReminder,
  enqueueBackorderReserved,
} from './backorder-feed-writes';

jest.mock('../../chatbot-requests/infrastructure/sale-feed-writes', () => ({
  saleConversationRef: jest.fn().mockResolvedValue('wa:1'),
}));
const insertFeedItems = jest.fn().mockResolvedValue(1);
jest.mock('../../chatbot-requests/infrastructure/chatbot-feed-writes', () => ({
  insertFeedItems: (...args: unknown[]) => insertFeedItems(...args) as unknown,
}));

const ROW = {
  id: 'bo-1',
  folio: 'BO-000001',
  version: 4,
  status: 'EXPIRED',
  quantity: 2,
  productId: 'p-1',
  variantId: null,
  customerId: 'c-1',
  sourceDecisionId: 'dec-7',
  referencePriceCents: 1000,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: new Date('2026-11-20T00:00:00.000Z'),
  estimatedAt: new Date('2026-11-27T00:00:00.000Z'),
  estimatedArrivalDays: 7,
  reservedUntil: null,
  reminderAt: null,
  expiredAt: new Date('2026-11-21T00:00:00.000Z'),
  cancelReason: 'Sin stock',
  product: { name: 'Croquetas' },
  variant: null,
  customer: { firstName: 'Rosa', phoneCountryCode: '52', phone: '5512348801' },
  tenant: { name: 'Centro' },
};

const tx = (row: Record<string, unknown>) =>
  ({
    backorder: {
      findFirst: jest.fn().mockResolvedValue(row),
      count: jest.fn().mockResolvedValue(0),
    },
  }) as never;
const payload = () =>
  (
    insertFeedItems.mock.calls[0] as [
      unknown,
      unknown,
      Array<{ payload: object }>,
    ]
  )[2][0].payload;

describe('backorder feed payloads carry the sourceDecisionId where the bot reschedules', () => {
  beforeEach(() => insertFeedItems.mockClear());

  it('reservation_expired: sourceDecisionId next to the unchanged members', async () => {
    await enqueueBackorderReservationExpired(tx(ROW), 't-1', 'bo-1');
    expect(payload()).toEqual({
      backorderId: 'bo-1',
      folio: 'BO-000001',
      productName: 'Croquetas',
      variantName: null,
      quantity: 2,
      branchName: 'Centro',
      customerFirstName: 'Rosa',
      phoneCountryCode: '52',
      phone: '5512348801',
      version: 4,
      expiredAt: '2026-11-21T00:00:00.000Z',
      sourceDecisionId: 'dec-7',
    });
  });

  it('cancelled_by_staff: sourceDecisionId next to the unchanged members', async () => {
    await enqueueBackorderCancelledByStaff(
      tx({ ...ROW, status: 'CANCELLED' }),
      't-1',
      'bo-1',
    );
    expect(payload()).toEqual({
      backorderId: 'bo-1',
      folio: 'BO-000001',
      productName: 'Croquetas',
      variantName: null,
      quantity: 2,
      branchName: 'Centro',
      customerFirstName: 'Rosa',
      phoneCountryCode: '52',
      phone: '5512348801',
      version: 4,
      reason: 'Sin stock',
      sourceDecisionId: 'dec-7',
    });
  });
});

describe('every backorder.* payload carries the customer phone (items with conversationRef null still reach the customer)', () => {
  beforeEach(() => insertFeedItems.mockClear());

  const run = async (
    enqueue: (tx: never, tenantId: string, id: string) => Promise<boolean>,
    row: Record<string, unknown>,
  ) => {
    await enqueue(tx(row), 't-1', 'bo-1');
    return payload() as Record<string, unknown>;
  };
  const RESERVED = {
    ...ROW,
    status: 'RESERVED',
    currentPriceCents: 900,
    finalPriceCents: 900,
    reservedUntil: new Date('2026-11-21T00:00:00.000Z'),
    reminderAt: new Date('2026-11-20T21:00:00.000Z'),
  };
  const cases: Array<[string, (...a: never[]) => Promise<boolean>, object]> = [
    ['reserved', enqueueBackorderReserved as never, RESERVED],
    ['reminder', enqueueBackorderReservationReminder as never, RESERVED],
    ['expired', enqueueBackorderReservationExpired as never, ROW],
    [
      'cancelled_by_staff',
      enqueueBackorderCancelledByStaff as never,
      { ...ROW, status: 'CANCELLED' },
    ],
    ['eta_updated', enqueueBackorderEtaUpdated as never, ROW],
    ['eta_unavailable', enqueueBackorderEtaUnavailable as never, ROW],
    [
      'reservation_lost',
      enqueueBackorderReservationLost as never,
      { ...ROW, status: 'WAITING' },
    ],
  ];

  it.each(cases)('%s: phoneCountryCode and phone', async (_name, fn, row) => {
    const body = await run(fn as never, row as never);
    expect(body).toMatchObject({ phoneCountryCode: '52', phone: '5512348801' });
  });

  it.each(cases)(
    '%s: null/null for a customer without a phone',
    async (_name, fn, row) => {
      const body = await run(fn as never, {
        ...row,
        customer: { firstName: 'Rosa', phoneCountryCode: null, phone: null },
      });
      expect(body).toMatchObject({ phoneCountryCode: null, phone: null });
    },
  );
});
