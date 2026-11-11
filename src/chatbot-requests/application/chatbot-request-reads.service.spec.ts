import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { CustomerKeySealer } from '../domain/customer-key-sealer';
import {
  ChatbotRequestReadsService,
  type ChatbotRequestReadStore,
  type DetailRecord,
  type GroupRecord,
  type RequestRecord,
} from './chatbot-request-reads.service';
import { ChatbotRequestCommandError } from './chatbot-request-commands.service';

const TENANT = 'tenant-1';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const KEY = '525512345678';
const sealer = new CustomerKeySealer('unit-secret-of-some-length');
const CASHIER = { can: () => false };
const MANAGER = { can: () => true };

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r-1',
  folio: 123,
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  version: 1,
  customerKey: KEY,
  customerId: null,
  phoneCountryCode: '52',
  phone: '5512345678',
  assigneeUserId: null,
  assigneeDisplayName: null,
  claimedAt: null,
  claimDeadlineAt: null,
  resolveDeadlineAt: null,
  overdueAt: null,
  whatsappWindowClosesAt: null,
  scheduledFor: null,
  requiresTemplateAtStart: false,
  needsReschedule: false,
  summary: 'Pregunta',
  createdAt: NOW,
  closedAt: null,
  resolvedByActorId: null,
  resolvedByDisplayName: null,
  urgencyAt: null,
  ...over,
});

const group = (over: Partial<GroupRecord> = {}): GroupRecord => ({
  customerKey: KEY,
  mostUrgentAt: null,
  openCount: 1,
  lastClosedAt: null,
  moreRequests: 0,
  requests: [record()],
  ...over,
});

function build(store: Partial<ChatbotRequestReadStore>) {
  const full = {
    tenantId: () => TENANT,
    customers: jest.fn().mockResolvedValue([]),
    ...store,
  } as ChatbotRequestReadStore;
  return new ChatbotRequestReadsService(full, sealer, () => NOW);
}

describe('ChatbotRequestReadsService', () => {
  it('masks the phone and seals customerKey in groups and in the cursor', async () => {
    const groups = jest
      .fn()
      .mockResolvedValue([group(), group({ customerKey: '525599999999' })]);
    const service = build({ groups });
    const page = await service.groups(
      { userId: 'u', ability: CASHIER },
      { tab: 'open', filters: {}, limit: 1 },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].customer.phone).toBe('55 **** 5678');
    expect(page.items[0].customerKey).toBe(sealer.seal(TENANT, KEY));
    expect(JSON.stringify(page)).not.toContain(KEY);
    expect(page.nextCursor).not.toBeNull();
    // the cursor goes back, is opened, and reaches the store with the raw key
    await service.groups(
      { userId: 'u', ability: CASHIER },
      { tab: 'open', filters: {}, cursor: page.nextCursor as string },
    );
    expect((groups.mock.calls[1] as [{ cursor: unknown }])[0].cursor).toEqual([
      null,
      KEY,
    ]);
    const full = await build({ groups }).groups(
      { userId: 'u', ability: MANAGER },
      { tab: 'open', filters: {} },
    );
    expect(full.items[0].customer.phone).toBe('+525512345678');
  });

  it('passes the 7-day cutoff of one clock reading to the store', async () => {
    const groups = jest.fn().mockResolvedValue([]);
    await build({ groups }).groups(
      { userId: 'u', ability: MANAGER },
      { tab: 'resolved', filters: {} },
    );
    expect((groups.mock.calls[0] as unknown[])[0]).toMatchObject({
      now: NOW,
      cutoff: new Date('2026-11-04T12:00:00.000Z'),
      limit: 25,
    });
  });

  it('rejects a cursor or customerKey that is not a sealed token of this tenant', async () => {
    const service = build({ listByCustomer: jest.fn().mockResolvedValue([]) });
    const reader = { userId: 'u', ability: MANAGER };
    await expect(
      service.listByCustomer(reader, { customerKey: KEY, tab: 'open' }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      service.listByCustomer(reader, {
        customerKey: sealer.seal('other-tenant', KEY),
        tab: 'open',
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      service.groups(reader, { tab: 'open', filters: {}, cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  describe('history range', () => {
    const history = jest.fn().mockResolvedValue([]);
    const reader = { userId: 'u', ability: MANAGER };
    const day = 86_400_000;
    const at = (days: number) => new Date(NOW.getTime() - days * day);

    it('accepts 92 days, rejects 93 with RANGE_TOO_LARGE and one-sided ranges', async () => {
      const service = build({ history });
      await expect(
        service.history(reader, { from: at(100), to: at(8) }),
      ).resolves.toBeDefined();
      await expect(
        service.history(reader, { from: at(100), to: at(7) }),
      ).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE', httpStatus: 400 });
      await expect(
        service.history(reader, { from: at(10) }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(
        service.history(reader, { from: at(5), to: at(10) }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('cuts at seven days before now', async () => {
      await build({ history }).history(reader, {});
      expect(
        (history.mock.calls.at(-1) as [{ cutoff: Date }])[0].cutoff,
      ).toEqual(at(7));
    });
  });

  it('answers 404 for a missing request in detail, audit and merge candidates', async () => {
    const service = build({
      findDetail: jest.fn().mockResolvedValue(null),
      audit: jest.fn().mockResolvedValue(null),
      mergeCandidates: jest.fn().mockResolvedValue(null),
    });
    const reader = { userId: 'u', ability: MANAGER };
    for (const call of [
      () => service.detail(reader, 'x'),
      () => service.audit('x', {}),
      () => service.mergeCandidates('x'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ChatbotRequestCommandError);
    }
  });

  it('detail: customer card without a linked customer, masked phone, 20 audit rows and a cursor', async () => {
    const audit = Array.from({ length: 21 }, (_, i) => ({
      id: `e-${i}`,
      type: 'SLA_MILESTONE',
      actorKind: 'SYSTEM',
      actorId: null,
      actorDisplayName: null,
      fromStatus: null,
      toStatus: null,
      version: 1,
      data: null,
      createdAt: new Date(NOW.getTime() - i * 1000),
    }));
    const detail: DetailRecord = {
      request: {
        ...record(),
        needs: null,
        context: null,
        resolution: null,
        resolvedAt: null,
      },
      customer: null,
      recentOrders: [],
      otherOpen: [],
      decision: null,
      zoneImpact: null,
      audit,
      deliveries: [
        {
          deliveryId: 'd',
          type: 'request.answered',
          createdAt: NOW,
          outcome: 'DELIVERY_UNKNOWN',
          attemptedAt: null,
        },
      ],
    };
    const view = await build({
      findDetail: jest.fn().mockResolvedValue(detail),
    }).detail({ userId: 'u', ability: CASHIER }, 'r-1');
    expect(view.customer).toMatchObject({
      id: null,
      displayName: null,
      phone: '55 **** 5678',
      recentOrders: [],
    });
    expect(view.audit).toHaveLength(20);
    expect(view.auditNextCursor).not.toBeNull();
    expect(view.audit[0].data).toEqual({});
    expect(view.deliveries[0]).toMatchObject({
      outcome: 'DELIVERY_UNKNOWN',
      needsReconciliation: true,
      providerStatus: null,
    });
    expect(view.allowedActions).toEqual([]);
  });
});
