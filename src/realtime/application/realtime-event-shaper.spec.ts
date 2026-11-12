/**
 * RealtimeEventShaper (unit 8; §12.8, R12): what each event type puts on the
 * wire, per recipient. The request rows themselves are covered by
 * `chatbot-request-reads.realtime.spec.ts`; here the services are doubles.
 */
import type { ChatbotRequestReadsService } from '../../chatbot-requests/application/chatbot-request-reads.service';
import type { NotificationsService } from '../../notifications/application/notifications.service';
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
    eventView: jest.fn().mockResolvedValue({
      notification: { id: 'n1' },
      unreadCount: 3,
    }),
    unreadCount: jest.fn().mockResolvedValue({ count: 2 }),
  };
  const shaper = new RealtimeEventShaper(
    tenants,
    reads as unknown as ChatbotRequestReadsService,
    notifications as unknown as NotificationsService,
  );
  return { shaper, reads, notifications, scopes, batch };
}

describe('RealtimeEventShaper', () => {
  it('prepares inside the tenant scope with the distinct request ids of the batch', async () => {
    const { shaper, reads, scopes } = setup();
    await shaper.prepare('t1', [
      event({ id: 1n, requestId: 'r-1' }),
      event({ id: 2n, requestId: 'r-1', type: 'request.claimed' }),
      event({ id: 3n, requestId: 'r-2', type: 'request.created' }),
      event({
        id: 4n,
        type: 'notification.read',
        userId: 'u',
        requestId: null,
        payload: { ids: null, all: true },
      }),
    ]);
    expect(scopes).toEqual(['t1']);
    expect(reads.loadEventRows).toHaveBeenCalledWith(['r-1', 'r-1', 'r-2']);
  });

  it('request events carry {request, customer, previousCustomerKey} built for the reader', async () => {
    const { shaper, reads } = setup();
    const prepared = await shaper.prepare('t1', [event({})]);
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
    const prepared = await shaper.prepare('t1', [event({})]);
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
    const prepared = await shaper.prepare('t1', [created]);
    expect(notifications.eventView).toHaveBeenCalledWith('ana', 'n1');
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

  it('a purged notification produces no frame', async () => {
    const { shaper, notifications } = setup();
    notifications.eventView.mockResolvedValue(null);
    const created = event({
      type: 'notification.created',
      userId: 'ana',
      payload: { notificationId: 'gone' },
    });
    const prepared = await shaper.prepare('t1', [created]);
    expect(
      shaper.shape(prepared, created, { userId: 'ana', ability: ABILITY }),
    ).toBeNull();
  });

  it('notification.read carries ids, all and the current unread count, once per user', async () => {
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
    const prepared = await shaper.prepare('t1', [one, all]);
    expect(notifications.unreadCount).toHaveBeenCalledTimes(1);
    const reader = { userId: 'ana', ability: ABILITY };
    expect(shaper.shape(prepared, one, reader)?.data).toEqual({
      ids: ['n1'],
      all: false,
      unreadCount: 2,
    });
    expect(shaper.shape(prepared, all, reader)?.data).toEqual({
      ids: null,
      all: true,
      unreadCount: 2,
    });
  });

  it('ignores unknown event types', async () => {
    const { shaper } = setup();
    const odd = event({ type: 'conversation.message' });
    const prepared = await shaper.prepare('t1', [odd]);
    expect(
      shaper.shape(prepared, odd, {
        userId: 'u',
        ability: ABILITY,
      }),
    ).toBeNull();
  });
});
