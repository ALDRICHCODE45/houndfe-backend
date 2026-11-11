import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { encodeRecoveryPage } from '../domain/chatbot-recovery';
import {
  ChatbotRecoveryService,
  type ChatbotRecoveryStore,
  type RecoveryRequestRow,
  type UndeliveredSummary,
} from './chatbot-recovery.service';
import type { FeedItemRow } from './chatbot-feed.service';

const request = (n: number, over: Partial<RecoveryRequestRow> = {}) =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    folio: n,
    kind: 'CLARIFICATION',
    subtype: 'UNKNOWN_QUESTION',
    status: 'NEW',
    conversationRef: `wa:${n}`,
    humanDecisionId: null,
    deliveryZoneRequestId: null,
    receiptEvidenceId: null,
    whatsappWindowClosesAt: null,
    cancelReason: null,
    createdAt: new Date('2026-11-10T10:00:00.000Z'),
    updatedAt: new Date(`2026-11-10T10:00:0${n}.000Z`),
    closedAt: null,
    ...over,
  }) satisfies RecoveryRequestRow;

const delivery = (
  requestId: string,
  cursor: bigint,
  outcome: string | null = null,
): FeedItemRow => ({
  cursor,
  deliveryId: `d-${cursor}`,
  type: 'request.answered',
  requestId,
  conversationRef: 'wa:1',
  payload: { kind: 'DECISION' },
  outcome,
});

function setup(
  rows: RecoveryRequestRow[] = [],
  deliveries: FeedItemRow[] = [],
  summary: UndeliveredSummary[] = [],
) {
  const events: string[] = [];
  const currentFeedCursor = jest.fn(() => {
    events.push('cursor');
    return Promise.resolve(1842n);
  });
  const readPage = jest.fn(() => {
    events.push('page');
    return Promise.resolve(rows);
  });
  const undelivered = jest.fn(() => Promise.resolve(deliveries));
  const undeliveredSummary = jest.fn(() => Promise.resolve(summary));
  const store: ChatbotRecoveryStore = {
    currentFeedCursor,
    readPage,
    undelivered,
    undeliveredSummary,
  };
  return {
    service: new ChatbotRecoveryService(store),
    mocks: { currentFeedCursor, readPage, undelivered, undeliveredSummary },
    events,
  };
}

describe('ChatbotRecoveryService (§3.3 recovery after 410 CURSOR_EXPIRED)', () => {
  it('reads the feed cursor BEFORE the requests, so nothing committed in between is missed', async () => {
    const { service, events } = setup([request(1)]);
    await service.recover({ status: 'open' });
    expect(events).toEqual(['cursor', 'page']);
  });

  it('returns the bot projection with the tenant max feed cursor as nextCursor', async () => {
    const r = request(1, { humanDecisionId: 'hd-1' });
    const { service } = setup([r]);
    const answer = await service.recover({ status: 'open' });
    expect(answer.nextCursor).toBe('000000001842');
    expect(answer.nextPage).toBeNull();
    expect(answer.items).toEqual([
      {
        id: r.id,
        folio: 'S-000001',
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        status: 'NEW',
        conversationRef: 'wa:1',
        legacyId: 'hd-1',
        whatsappWindowClosesAt: null,
        cancelReason: null,
        createdAt: '2026-11-10T10:00:00.000Z',
        updatedAt: '2026-11-10T10:00:01.000Z',
        closedAt: null,
        pendingDeliveries: [],
        undeliveredTruncated: false,
        undeliveredResumeAfter: null,
      },
    ]);
  });

  it('never exposes the customer, the assignee or the staff', async () => {
    const { service } = setup([request(1)]);
    const [item] = (await service.recover({ status: 'open' })).items;
    expect(Object.keys(item)).not.toEqual(
      expect.arrayContaining(['customerKey']),
    );
    expect(JSON.stringify(item)).not.toMatch(
      /customerKey|phone|assignee|resolvedBy|summary|needs/,
    );
  });

  it('attaches each request its undelivered items with the deferral reason', async () => {
    const a = request(1);
    const b = request(2);
    const { service, mocks } = setup(
      [a, b],
      [
        delivery(a.id, 5n),
        delivery(a.id, 6n, 'DEFERRED_HUMAN_SESSION'),
        delivery(b.id, 7n, 'DEFERRED_WINDOW_CLOSED'),
      ],
    );
    const { items } = await service.recover({ status: 'open' });
    expect(mocks.undelivered).toHaveBeenCalledWith([a.id, b.id], 5);
    expect(
      items.map((i) =>
        i.pendingDeliveries.map((d) => [
          d.deliveryId,
          d.type,
          d.deferredReason,
        ]),
      ),
    ).toEqual([
      [
        ['d-5', 'request.answered', null],
        ['d-6', 'request.answered', 'HUMAN_SESSION'],
      ],
      [['d-7', 'request.answered', 'WINDOW_CLOSED']],
    ]);
    expect(items[0].pendingDeliveries[0]).toMatchObject({
      cursor: '000000000005',
      requestId: a.id,
      payload: { kind: 'DECISION' },
    });
  });

  it('skips the deliveries query when the page is empty', async () => {
    const { service, mocks } = setup([]);
    const answer = await service.recover({ status: 'open' });
    expect(answer).toEqual({
      items: [],
      nextCursor: '000000001842',
      nextPage: null,
    });
    expect(mocks.undelivered).not.toHaveBeenCalled();
  });

  it('asks the store for one row more than the limit to know whether another page exists', async () => {
    const rows = [request(1), request(2), request(3)];
    const { service, mocks } = setup(rows);
    const answer = await service.recover({ status: 'open', limit: '2' });
    expect(mocks.readPage).toHaveBeenCalledWith({
      since: null,
      after: null,
      limit: 3,
    });
    expect(answer.items.map((i) => i.folio)).toEqual(['S-000001', 'S-000002']);
    expect(answer.nextPage).toEqual(expect.any(String));
  });

  it('the next page resumes after the last (updatedAt, id) and keeps the first page feed cursor', async () => {
    const rows = [request(1), request(2), request(3)];
    const first = setup(rows);
    const { nextPage } = await first.service.recover({
      status: 'open',
      limit: '2',
    });
    const second = setup([request(3)]);
    const answer = await second.service.recover({
      status: 'open',
      limit: '2',
      cursor: nextPage as string,
    });
    // Not re-read: the cursor of the first page is the resume point.
    expect(second.mocks.currentFeedCursor).not.toHaveBeenCalled();
    expect(second.mocks.readPage).toHaveBeenCalledWith({
      since: null,
      after: { updatedAt: rows[1].updatedAt, id: rows[1].id },
      limit: 3,
    });
    expect(answer.nextCursor).toBe('000000001842');
    expect(answer.nextPage).toBeNull();
  });

  it('passes updatedSince to the store', async () => {
    const { service, mocks } = setup([]);
    await service.recover({
      status: 'open',
      updatedSince: '2026-11-10T16:20:00.000Z',
    });
    // 5 s earlier: replicas stamp updatedAt/closedAt with their own clocks.
    expect(mocks.readPage).toHaveBeenCalledWith({
      since: new Date('2026-11-10T16:19:55.000Z'),
      after: null,
      limit: 51,
    });
  });

  it('flags a request with more undelivered items than it lists, and says where to resume the feed', async () => {
    const a = request(1);
    const b = request(2);
    const { service, mocks } = setup(
      [a, b],
      [delivery(a.id, 9n), delivery(b.id, 10n)],
      [
        { requestId: a.id, count: 8, oldestCursor: 4n },
        { requestId: b.id, count: 5, oldestCursor: 10n },
      ],
    );
    const { items } = await service.recover({ status: 'open' });
    expect(mocks.undeliveredSummary).toHaveBeenCalledWith([a.id, b.id]);
    expect(
      items.map((i) => [i.undeliveredTruncated, i.undeliveredResumeAfter]),
    ).toEqual([
      // `after` that makes the feed serve cursor 4 again.
      [true, '000000000003'],
      [false, null],
    ]);
  });

  it('rejects a malformed query before touching the store', async () => {
    const { service, mocks } = setup();
    await expect(service.recover({ status: 'closed' })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(mocks.currentFeedCursor).not.toHaveBeenCalled();
    expect(mocks.readPage).not.toHaveBeenCalled();
  });

  it('a tampered page cursor is a 400, not a crash', async () => {
    const { service } = setup();
    const token = encodeRecoveryPage({
      updatedAt: new Date('2026-11-10T10:00:00.000Z'),
      id: 'not-a-uuid',
      feedCursor: 1n,
    });
    await expect(
      service.recover({ status: 'open', cursor: token }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
