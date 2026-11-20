/**
 * `sourceDecisionId` in the payload of `backorder.reservation_expired` and
 * `backorder.cancelled_by_staff` (restock-backorder T4, chatbot request): after
 * an expiry or a staff cancel the bot reschedules by repeating
 * `POST /chatbot-api/backorders` with the same `sourceDecisionId`. Additive: the
 * existing members are untouched and the other item types do not carry it.
 */
import {
  enqueueBackorderCancelledByStaff,
  enqueueBackorderReservationExpired,
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
  customer: { firstName: 'Rosa' },
  tenant: { name: 'Centro' },
};

const tx = (row: Record<string, unknown>) =>
  ({ backorder: { findFirst: jest.fn().mockResolvedValue(row) } }) as never;
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
      version: 4,
      reason: 'Sin stock',
      sourceDecisionId: 'dec-7',
    });
  });
});
