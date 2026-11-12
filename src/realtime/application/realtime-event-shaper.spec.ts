/**
 * RealtimeEventShaper (unit 8; §12.8, R12): what each event type puts on the
 * wire, per recipient. The request rows themselves are covered by
 * `chatbot-request-reads.realtime.spec.ts`; here the services are doubles.
 */
import type { ChatbotRequestReadsService } from '../../chatbot-requests/application/chatbot-request-reads.service';
import type { MessageView } from '../../conversations/domain/message-view';
import type { ConversationEventReader } from './conversation-event-reader';
import type { NotificationEventReader } from './notification-event-reader';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
import { RealtimeEventShaper } from './realtime-event-shaper';

const ABILITY = { can: () => true };
const event = (over: Partial<RealtimeEventRow>): RealtimeEventRow => ({
  id: 10n,
  tenantId: 't1',
  userId: null,
  type: 'request.updated',
  requestId: 'r-1',
  payload: { version: 2 },
  createdAt: new Date(),
  ...over,
});

function setup() {
  const scopes: string[] = [];
  const tenants = {
    runWithTenant: (tenantId: string, fn: () => Promise<unknown>) => {
      scopes.push(tenantId);
      return fn();
    },
  } as unknown as TenantRunnerService;
  const batch = { rows: new Map(), customers: new Map(), view: {} };
  const reads = {
    loadEventRows: jest.fn().mockResolvedValue(batch),
    shapeEventRow: jest
      .fn()
      .mockImplementation(
        (_b, id: string, reader: { userId: string }, prev) => ({
          request: { id, for: reader.userId },
          customer: {},
          previousCustomerKey: prev ? `sealed(${prev as string})` : null,
        }),
      ),
  };
  const notifications = {
    /** Notices by id, only those owned by the wanted user (like the real one). */
    views: jest
      .fn<
        Promise<Map<string, { id: string }>>,
        [Array<{ userId: string; id: string }>]
      >()
      .mockImplementation((wanted) =>
        Promise.resolve(new Map(wanted.map((w) => [w.id, { id: w.id }]))),
      ),
    unreadCounts: jest
      .fn<Promise<Map<string, number>>, [string[]]>()
      .mockImplementation((users) =>
        Promise.resolve(new Map(users.map((u) => [u, u === 'ana' ? 3 : 5]))),
      ),
  };
  const conversations = {
    /** The CURRENT view of each message that still exists. */
    messages: jest
      .fn<Promise<Map<string, MessageView>>, [string[]]>()
      .mockImplementation((ids) =>
        Promise.resolve(
          new Map(
            ids
              .filter((id) => id !== 'purged')
              .map((id, i) => [
                id,
                {
                  id,
                  seq: 7 + i,
                  deliveryStatus: 'DELIVERED',
                  text: `words of ${id}`,
                } as unknown as MessageView,
              ]),
          ),
        ),
      ),
  };
  const shaper = new RealtimeEventShaper(
    tenants,
    reads as unknown as ChatbotRequestReadsService,
    notifications as unknown as NotificationEventReader,
    conversations as unknown as ConversationEventReader,
  );
  return { shaper, reads, notifications, conversations, scopes, batch };
}

const EVERYONE = new Set(['ana', 'luis']);

describe('RealtimeEventShaper', () => {
  it('prepares inside the tenant scope with the distinct request ids of the batch', async () => {
    const { shaper, reads, scopes } = setup();
    await shaper.prepare(
      't1',
      [
        event({ id: 1n, requestId: 'r-1' }),
        event({ id: 2n, requestId: 'r-1', type: 'request.claimed' }),
        event({ id: 3n, requestId: 'r-2', type: 'request.created' }),
        event({
          id: 4n,
          type: 'notification.read',
          userId: 'ana',
          requestId: null,
          payload: { ids: null, all: true },
        }),
      ],
      EVERYONE,
    );
    expect(scopes).toEqual(['t1']);
    expect(reads.loadEventRows).toHaveBeenCalledWith(['r-1', 'r-1', 'r-2']);
  });

  it('request events carry {request, customer, previousCustomerKey} built for the reader', async () => {
    const { shaper, reads } = setup();
    const prepared = await shaper.prepare('t1', [event({})], EVERYONE);
    const frame = shaper.shape(
      prepared,
      event({ payload: { version: 2, previousCustomerKey: '5255' } }),
      { userId: 'ana', ability: ABILITY },
    );
    expect(frame).toEqual({
      id: 10n,
      event: 'request.updated',
      data: {
        request: { id: 'r-1', for: 'ana' },
        customer: {},
        previousCustomerKey: 'sealed(5255)',
      },
    });
    expect(reads.shapeEventRow).toHaveBeenCalledWith(
      expect.anything(),
      'r-1',
      { userId: 'ana', ability: ABILITY },
      '5255',
    );
  });

  it('sends nothing when the row cannot be shown to the reader', async () => {
    const { shaper, reads } = setup();
    reads.shapeEventRow.mockReturnValue(null);
    const prepared = await shaper.prepare('t1', [event({})], EVERYONE);
    expect(
      shaper.shape(prepared, event({}), { userId: 'u', ability: ABILITY }),
    ).toBeNull();
  });

  it('notification.created carries the notice and the owner unread count, only to the owner', async () => {
    const { shaper, notifications } = setup();
    const created = event({
      id: 11n,
      type: 'notification.created',
      userId: 'ana',
      payload: { notificationId: 'n1' },
    });
    const prepared = await shaper.prepare('t1', [created], EVERYONE);
    expect(notifications.views).toHaveBeenCalledWith([
      { userId: 'ana', id: 'n1' },
    ]);
    expect(
      shaper.shape(prepared, created, { userId: 'ana', ability: ABILITY }),
    ).toEqual({
      id: 11n,
      event: 'notification.created',
      data: { notification: { id: 'n1' }, unreadCount: 3 },
    });
    expect(
      shaper.shape(prepared, created, { userId: 'luis', ability: ABILITY }),
    ).toBeNull();
  });

  it('a purged (or foreign) notification produces no frame', async () => {
    const { shaper, notifications } = setup();
    notifications.views.mockResolvedValue(new Map());
    const created = event({
      type: 'notification.created',
      userId: 'ana',
      payload: { notificationId: 'gone' },
    });
    const prepared = await shaper.prepare('t1', [created], EVERYONE);
    expect(
      shaper.shape(prepared, created, { userId: 'ana', ability: ABILITY }),
    ).toBeNull();
  });

  it('notification.read carries ids, all and the current unread count', async () => {
    const { shaper, notifications } = setup();
    const one = event({
      id: 12n,
      type: 'notification.read',
      userId: 'ana',
      requestId: null,
      payload: { ids: ['n1'], all: false },
    });
    const all = event({
      id: 13n,
      type: 'notification.read',
      userId: 'ana',
      requestId: null,
      payload: { ids: null, all: true },
    });
    const prepared = await shaper.prepare('t1', [one, all], EVERYONE);
    expect(notifications.unreadCounts).toHaveBeenCalledTimes(1);
    expect(notifications.unreadCounts).toHaveBeenCalledWith(['ana']);
    const reader = { userId: 'ana', ability: ABILITY };
    expect(shaper.shape(prepared, one, reader)?.data).toEqual({
      ids: ['n1'],
      all: false,
      unreadCount: 3,
    });
    expect(shaper.shape(prepared, all, reader)?.data).toEqual({
      ids: null,
      all: true,
      unreadCount: 3,
    });
  });

  describe('cost: only users connected on this replica, one query per batch', () => {
    const created = (id: bigint, userId: string, nid: string) =>
      event({
        id,
        type: 'notification.created',
        userId,
        requestId: null,
        payload: { notificationId: nid },
      });

    it('recipients with no stream here cost no query at all', async () => {
      const { shaper, notifications } = setup();
      await shaper.prepare(
        't1',
        [
          created(1n, 'nobody', 'n1'),
          created(2n, 'elsewhere', 'n2'),
          event({
            id: 3n,
            type: 'notification.read',
            userId: 'nobody',
            requestId: null,
            payload: { ids: null, all: true },
          }),
        ],
        EVERYONE,
      );
      expect(notifications.views).not.toHaveBeenCalled();
      expect(notifications.unreadCounts).not.toHaveBeenCalled();
    });

    it('a batch of notices for several connected users is one views query and one count query', async () => {
      const { shaper, notifications } = setup();
      const batch = [
        created(1n, 'ana', 'n1'),
        created(2n, 'ana', 'n2'),
        created(3n, 'luis', 'n3'),
        created(4n, 'nobody', 'n4'),
        event({
          id: 5n,
          type: 'notification.read',
          userId: 'luis',
          requestId: null,
          payload: { ids: ['n3'], all: false },
        }),
      ];
      const prepared = await shaper.prepare('t1', batch, EVERYONE);
      expect(notifications.views).toHaveBeenCalledTimes(1);
      expect(notifications.views).toHaveBeenCalledWith([
        { userId: 'ana', id: 'n1' },
        { userId: 'ana', id: 'n2' },
        { userId: 'luis', id: 'n3' },
      ]);
      expect(notifications.unreadCounts).toHaveBeenCalledTimes(1);
      expect(
        [...(notifications.unreadCounts.mock.calls[0][0] ?? [])].sort(),
      ).toEqual(['ana', 'luis']);
      const luis = { userId: 'luis', ability: ABILITY };
      expect(shaper.shape(prepared, batch[2], luis)?.data).toEqual({
        notification: { id: 'n3' },
        unreadCount: 5,
      });
    });

    it('a batch with no notification events runs no notification query', async () => {
      const { shaper, notifications } = setup();
      await shaper.prepare('t1', [event({})], EVERYONE);
      expect(notifications.views).not.toHaveBeenCalled();
      expect(notifications.unreadCounts).not.toHaveBeenCalled();
    });
  });

  it('ignores unknown event types', async () => {
    const { shaper } = setup();
    const odd = event({ type: 'conversation.message' });
    const prepared = await shaper.prepare('t1', [odd], EVERYONE);
    expect(
      shaper.shape(prepared, odd, {
        userId: 'u',
        ability: ABILITY,
      }),
    ).toBeNull();
  });

  describe('conversation events (unit 9; §12.8, §5.3)', () => {
    const message = (over: Partial<RealtimeEventRow> = {}) =>
      event({
        id: 20n,
        type: 'conversation.message',
        requestId: 'r-1',
        payload: { messageId: 'm-1', seq: 7 },
        ...over,
      });
    const status = (over: Partial<RealtimeEventRow> = {}) =>
      event({
        id: 21n,
        type: 'message.status',
        requestId: 'r-1',
        payload: { messageId: 'm-1', seq: 7, deliveryStatus: 'SENT' },
        ...over,
      });
    const withConversation = { userId: 'ana', ability: { can: () => true } };
    const withoutConversation = {
      userId: 'luis',
      ability: {
        can: (action: string, subject: string) =>
          subject !== 'ChatbotConversation',
      },
    };

    it('loads the messages of a batch once, by id, inside the tenant scope', async () => {
      const { shaper, conversations, reads, scopes } = setup();
      await shaper.prepare(
        't1',
        [
          message(),
          message({ id: 22n, payload: { messageId: 'm-2', seq: 8 } }),
          status(),
          event({}),
        ],
        EVERYONE,
      );
      expect(scopes).toEqual(['t1']);
      expect(conversations.messages).toHaveBeenCalledTimes(1);
      expect([...conversations.messages.mock.calls[0][0]].sort()).toEqual([
        'm-1',
        'm-2',
      ]);
      // A conversation event is not a request row event.
      expect(reads.loadEventRows).toHaveBeenCalledWith(['r-1']);
    });

    it('a batch with no conversation event costs no message query', async () => {
      const { shaper, conversations } = setup();
      await shaper.prepare('t1', [event({})], EVERYONE);
      expect(conversations.messages).not.toHaveBeenCalled();
    });

    it('conversation.message carries {requestId, message} for a reader with read:ChatbotConversation', async () => {
      const { shaper } = setup();
      const e = message();
      const prepared = await shaper.prepare('t1', [e], EVERYONE);
      const frame = shaper.shape(prepared, e, withConversation);
      expect(frame).toEqual({
        id: 20n,
        event: 'conversation.message',
        data: {
          requestId: 'r-1',
          message: expect.objectContaining({
            id: 'm-1',
            text: 'words of m-1',
          }) as unknown,
        },
      });
    });

    it('message.status carries the CURRENT status, not the one logged', async () => {
      const { shaper } = setup();
      const e = status();
      const prepared = await shaper.prepare('t1', [e], EVERYONE);
      expect(shaper.shape(prepared, e, withConversation)).toEqual({
        id: 21n,
        event: 'message.status',
        data: {
          requestId: 'r-1',
          messageId: 'm-1',
          seq: 7,
          deliveryStatus: 'DELIVERED',
        },
      });
    });

    it('nobody without read:ChatbotConversation gets either event (per-recipient shaping)', async () => {
      const { shaper } = setup();
      const events = [message(), status()];
      const prepared = await shaper.prepare('t1', events, EVERYONE);
      for (const e of events) {
        expect(shaper.shape(prepared, e, withoutConversation)).toBeNull();
      }
    });

    it('a role with read:ChatbotConversation but WITHOUT read:ChatbotRequest gets neither event (REST needs both)', async () => {
      const { shaper } = setup();
      const events = [message(), status()];
      const prepared = await shaper.prepare('t1', events, EVERYONE);
      const conversationOnly = {
        userId: 'rosa',
        ability: {
          can: (action: string, subject: string) =>
            subject !== 'ChatbotRequest',
        },
      };
      for (const e of events) {
        expect(shaper.shape(prepared, e, conversationOnly)).toBeNull();
        // Control: with both subjects the same events are delivered.
        expect(shaper.shape(prepared, e, withConversation)).not.toBeNull();
      }
    });

    it('a purged message or an event with no request produces no frame', async () => {
      const { shaper } = setup();
      const gone = message({ payload: { messageId: 'purged', seq: 1 } });
      const orphan = message({ id: 23n, requestId: null });
      const prepared = await shaper.prepare('t1', [gone, orphan], EVERYONE);
      expect(shaper.shape(prepared, gone, withConversation)).toBeNull();
      expect(shaper.shape(prepared, orphan, withConversation)).toBeNull();
    });
  });
});
