/**
 * `enqueueAnswered` and the staff-only requests (restock-backorder T4b a): the
 * server-created overdue-ETA RESTOCK request (`context.origin =
 * BACKORDER_REESTIMATE`) never produces a generic `request.answered`, whichever
 * route closed it (the common `resolve` of the inbox included). Every other
 * request keeps its answer.
 */
import { STAFF_ONLY_REQUEST_ORIGIN } from '../domain/staff-only-request';
import { STAFF_ONLY_REQUEST_ORIGIN as REEXPORTED } from './chatbot-request-wrapper';
import { enqueueAnswered } from './chatbot-feed-writes';

const row = (id: string, context: unknown, humanDecisionId = `hd-${id}`) => ({
  id,
  subtype: 'RESTOCK',
  conversationRef: null,
  humanDecisionId,
  deliveryZoneRequestId: null,
  receiptEvidenceId: null,
  context,
});

function build(requests: ReturnType<typeof row>[]) {
  const tx = {
    chatbotRequest: { findMany: jest.fn().mockResolvedValue(requests) },
    humanDecision: {
      findMany: jest.fn().mockResolvedValue(
        requests.map((r) => ({
          id: r.humanDecisionId,
          status: 'RESOLVED',
          productName: 'Croquetas',
          resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 5,
          expirationText: null,
        })),
      ),
    },
    deliveryZoneRequest: { findMany: jest.fn().mockResolvedValue([]) },
    receiptEvidence: { findMany: jest.fn().mockResolvedValue([]) },
    chatbotFeedItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return tx;
}

const created = (tx: ReturnType<typeof build>) =>
  (
    tx.chatbotFeedItem.createMany.mock.calls as Array<
      [{ data: Array<{ requestId: string; type: string }> }]
    >
  ).flatMap(([arg]) => arg.data);

describe('staff-only request origin', () => {
  it('lives in the domain and the wrapper keeps exporting it', () => {
    expect(STAFF_ONLY_REQUEST_ORIGIN).toBe('BACKORDER_REESTIMATE');
    expect(REEXPORTED).toBe(STAFF_ONLY_REQUEST_ORIGIN);
  });
});

describe('enqueueAnswered', () => {
  it('writes nothing for a staff-only request (no item, no feed lock, no NOTIFY)', async () => {
    const tx = build([row('r1', { origin: STAFF_ONLY_REQUEST_ORIGIN })]);

    await enqueueAnswered(tx as never, 't-1', ['r1']);

    expect(tx.chatbotFeedItem.createMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers the ordinary requests of a mixed set and skips only the staff-only ones', async () => {
    const tx = build([
      row('r1', { origin: STAFF_ONLY_REQUEST_ORIGIN }),
      row('r2', { productId: 'p-1' }),
      row('r3', null),
    ]);

    await enqueueAnswered(tx as never, 't-1', ['r1', 'r2', 'r3']);

    expect(created(tx).map((item) => [item.requestId, item.type])).toEqual([
      ['r2', 'request.answered'],
      ['r3', 'request.answered'],
    ]);
  });

  it('another origin value is not staff-only', async () => {
    const tx = build([row('r1', { origin: 'SOMETHING_ELSE' })]);

    await enqueueAnswered(tx as never, 't-1', ['r1']);

    expect(created(tx)).toHaveLength(1);
  });

  it('still fails the transaction when a request is not resolved', async () => {
    const tx = build([]);

    await expect(enqueueAnswered(tx as never, 't-1', ['r1'])).rejects.toThrow(
      'the wrapped row is not resolved',
    );
  });
});
