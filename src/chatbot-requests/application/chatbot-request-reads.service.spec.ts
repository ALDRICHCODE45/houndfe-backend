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

  it('answers 400, not a database error, for a well-formed cursor with a bad date or id', async () => {
    const service = build({
      groups: jest.fn().mockResolvedValue([]),
      listByCustomer: jest.fn().mockResolvedValue([]),
      history: jest.fn().mockResolvedValue([]),
      audit: jest.fn().mockResolvedValue([]),
    });
    const reader = { userId: 'u', ability: MANAGER };
    const cursor = (...parts: Array<string | null>) =>
      Buffer.from(JSON.stringify(parts)).toString('base64url');
    const key = sealer.seal(TENANT, KEY);
    const date = '2026-11-10T00:00:00.000Z';
    const id = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';
    const bad = [
      () =>
        service.groups(reader, {
          tab: 'open',
          filters: {},
          cursor: cursor('nope', key),
        }),
      () =>
        service.groups(reader, {
          tab: 'resolved',
          filters: {},
          cursor: cursor(null, key),
        }),
      () =>
        service.listByCustomer(reader, {
          customerKey: key,
          tab: 'open',
          cursor: cursor(date, 'nope', id),
        }),
      () =>
        service.listByCustomer(reader, {
          customerKey: key,
          tab: 'open',
          cursor: cursor(null, date, 'not-a-uuid'),
        }),
      () =>
        service.listByCustomer(reader, {
          customerKey: key,
          tab: 'resolved',
          cursor: cursor(date, 'not-a-uuid'),
        }),
      () =>
        service.history(reader, {
          cursor: cursor('0000-01-01T00:00:00.000Z', id),
        }),
      () => service.history(reader, { cursor: cursor(date, 'x') }),
      () =>
        service.audit('r-1', {
          cursor: cursor('2026-02-30T00:00:00.000Z', id),
        }),
    ];
    for (const call of bad) {
      await expect(call()).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    // the same shapes with good parts are accepted
    await expect(
      service.listByCustomer(reader, {
        customerKey: key,
        tab: 'open',
        cursor: cursor(null, date, id),
      }),
    ).resolves.toBeDefined();
    await expect(
      service.groups(reader, {
        tab: 'open',
        filters: {},
        cursor: cursor(null, key),
      }),
    ).resolves.toBeDefined();
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

    it('rejects from/to that PostgreSQL cannot store', async () => {
      const service = build({ history });
      await expect(
        service.history(reader, {
          from: new Date('0001-01-01T00:00:00.000Z'),
          to: new Date('0001-02-01T00:00:00.000Z'),
        }),
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

  it('detail: no RESOLVE on a zone request without a validation, RESOLVE with one', async () => {
    const grants = ['update:ChatbotRequest', 'validate:DeliveryZone'];
    const ability = {
      can: (action: string, subject: string) =>
        grants.includes(`${action}:${subject}`),
    };
    const detail = (zoneImpact: DetailRecord['zoneImpact']): DetailRecord => ({
      request: {
        ...record({ kind: 'DECISION', subtype: 'DELIVERY_ZONE' }),
        needs: null,
        context: null,
        resolution: null,
        resolvedAt: null,
        ambiguousCustomer: false,
      },
      candidates: [],
      hasMergeCandidate: false,
      customer: null,
      recentOrders: [],
      otherOpen: [],
      decision: { subtype: 'DELIVERY_ZONE' },
      zoneImpact,
      audit: [],
      deliveries: [],
    });
    const view = async (zoneImpact: DetailRecord['zoneImpact']) =>
      build({
        findDetail: jest.fn().mockResolvedValue(detail(zoneImpact)),
      }).detail({ userId: 'u', ability }, 'r-1');
    // the fixture has no customer, so linking one is offered too
    expect((await view(null)).allowedActions).toEqual([
      'CLAIM',
      'LINK_CUSTOMER',
    ]);
    const impact = {
      validationId: 'v-1',
      requests: 2,
      customers: 2,
      setVersion: 2,
    };
    expect((await view(impact)).allowedActions).toEqual([
      'CLAIM',
      'RESOLVE',
      'LINK_CUSTOMER',
    ]);
    expect((await view(impact)).zoneImpact).toEqual(impact);
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
        ambiguousCustomer: false,
      },
      candidates: [],
      hasMergeCandidate: false,
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

  describe('q (§3.8)', () => {
    const NO_PHONE = { can: () => false };
    const WITH_PHONE = {
      can: (action: string, subject: string) =>
        `${action}:${subject}` === 'read:CustomerPhone',
    };
    const searched = async (q: string, ability: { can: () => boolean }) => {
      const groups = jest.fn().mockResolvedValue([]);
      const page = await build({ groups }).groups(
        { userId: 'u', ability: ability as never },
        { tab: 'open', filters: { subtype: 'UNKNOWN_QUESTION' }, q },
      );
      return { groups, page };
    };

    it('does not even query for digits without read:CustomerPhone (no phone oracle)', async () => {
      const { groups, page } = await searched('5512345678', NO_PHONE);
      expect(groups).not.toHaveBeenCalled();
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it('hands the parsed search to the store, keeping the other filters', async () => {
      const phone = await searched('55 1234', WITH_PHONE as never);
      expect(
        (phone.groups.mock.calls[0] as [{ filters: unknown }])[0].filters,
      ).toEqual({
        subtype: 'UNKNOWN_QUESTION',
        search: { kind: 'phone', digits: '551234' },
      });
      const folio = await searched('S-000123', NO_PHONE);
      expect(
        (folio.groups.mock.calls[0] as [{ filters: unknown }])[0].filters,
      ).toMatchObject({ search: { kind: 'folio', folio: 123 } });
      const name = await searched('María', NO_PHONE);
      expect(
        (name.groups.mock.calls[0] as [{ filters: unknown }])[0].filters,
      ).toMatchObject({ search: { kind: 'name', tokens: ['maria'] } });
    });

    it('an empty q is no search', async () => {
      const blank = await searched('  ', NO_PHONE);
      expect(
        (blank.groups.mock.calls[0] as [{ filters: unknown }])[0].filters,
      ).toEqual({ subtype: 'UNKNOWN_QUESTION' });
    });
  });

  it('assignableUsers returns only id and displayName (name, else email local part)', async () => {
    const out = await build({
      assignableUsers: jest.fn().mockResolvedValue([
        { id: 'u-1', name: 'Ana', email: 'ana@shop.test' },
        { id: 'u-2', name: ' ', email: 'luis@shop.test' },
      ]),
    }).assignableUsers();
    expect(out).toEqual({
      items: [
        { id: 'u-1', displayName: 'Ana' },
        { id: 'u-2', displayName: 'luis' },
      ],
    });
  });

  describe('detail: R1 candidates and MERGE / LINK_CUSTOMER', () => {
    const candidate = (id: string) => ({
      id,
      firstName: 'Rosa',
      lastName: 'Gómez',
      phoneCountryCode: '52',
      phone: '5512345678',
      isTrusted: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      priceList: null,
      lastOrderAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const detail = (over: Partial<DetailRecord> = {}): DetailRecord => ({
      request: {
        ...record(),
        needs: null,
        context: null,
        resolution: null,
        resolvedAt: null,
        ambiguousCustomer: true,
      },
      candidates: [candidate('c-1'), candidate('c-2')],
      hasMergeCandidate: true,
      customer: null,
      recentOrders: [],
      otherOpen: [],
      decision: null,
      zoneImpact: null,
      audit: [],
      deliveries: [],
      ...over,
    });
    const UPDATE = {
      can: (action: string, subject: string) =>
        `${action}:${subject}` === 'update:ChatbotRequest',
    };
    const view = (ability: { can: (a: string, s: string) => boolean }) =>
      build({
        findDetail: jest.fn().mockResolvedValue(detail()),
      }).detail({ userId: 'u', ability: ability as never }, 'r-1');

    it('lists the candidates with the phone masked unless read:CustomerPhone', async () => {
      const masked = await view(UPDATE);
      expect(masked.customer.ambiguous).toBe(true);
      expect(masked.customer.candidates).toEqual([
        expect.objectContaining({
          id: 'c-1',
          displayName: 'Rosa Gómez',
          phone: '55 **** 5678',
          lastOrderAt: '2026-10-01T00:00:00.000Z',
        }),
        expect.objectContaining({ id: 'c-2', phone: '55 **** 5678' }),
      ]);
      expect(JSON.stringify(masked)).not.toContain('5512345678');
      const full = await view({
        can: (action, subject) =>
          UPDATE.can(action, subject) ||
          `${action}:${subject}` === 'read:CustomerPhone',
      });
      expect(full.customer.candidates[0].phone).toBe('+525512345678');
    });

    it('offers MERGE and LINK_CUSTOMER with update:ChatbotRequest, never without it', async () => {
      expect((await view(UPDATE)).allowedActions).toEqual([
        'CLAIM',
        'MERGE',
        'LINK_CUSTOMER',
        'CANCEL',
      ]);
      expect((await view({ can: () => false })).allowedActions).toEqual([]);
    });

    it('hides both when there is no candidate request and the customer is linked', async () => {
      const linked = detail({
        hasMergeCandidate: false,
        candidates: [],
        request: {
          ...detail().request,
          customerId: 'c-1',
          ambiguousCustomer: false,
        },
      });
      const out = await build({
        findDetail: jest.fn().mockResolvedValue(linked),
      }).detail({ userId: 'u', ability: UPDATE as never }, 'r-1');
      expect(out.allowedActions).toEqual(['CLAIM', 'CANCEL']);
    });
  });
});
