/**
 * S9 additions to the staff reads (unit 4 follow-ups requested by the FE):
 *
 *   1. the by-customer list takes the same filters as the groups (`q`,
 *      `assignee`, `overdue`, `windowClosingSoon`, `subtype`), parsed by the
 *      same code, so the phone-digits rule (R12) holds there too;
 *   2. `counts.unassigned` passes through with the old counts;
 *   3. every group carries `overdueCount` (exact, from the store);
 *   4. history rows carry the customer card with the group rules;
 *   5. the realtime row is the inbox row: the new fields live beside it.
 *
 * The earlier specs of the service are not touched.
 */
import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { policyFromSettings, slaLevel } from '../domain/chatbot-sla';
import { CustomerKeySealer } from '../domain/customer-key-sealer';
import {
  ChatbotRequestReadsService,
  type ChatbotRequestReadStore,
  type CustomerRecord,
  type GroupRecord,
  type RequestRecord,
  type SlaPauseReader,
} from './chatbot-request-reads.service';

const TENANT = 'tenant-1';
const NOW = new Date('2026-11-10T10:20:00-06:00');
const KEY = '525512345678';
const sealer = new CustomerKeySealer('unit-secret-of-some-length');

const abilityOf = (...grants: string[]) => ({
  can: (action: string, subject: string) =>
    grants.includes(`${action}:${subject}`),
});
const CASHIER = abilityOf('read:ChatbotRequest', 'update:ChatbotRequest');
const MANAGER = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
  'update:ChatbotRequestAssignment',
  'read:CustomerPhone',
);
const as = (ability: ReturnType<typeof abilityOf>) => ({
  userId: 'u-me',
  ability,
});

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
  createdAt: new Date('2026-11-10T10:00:00-06:00'),
  closedAt: null,
  resolvedByActorId: null,
  resolvedByDisplayName: null,
  urgencyAt: null,
  ...over,
});

const customer: CustomerRecord = {
  id: 'c-1',
  firstName: 'Juan',
  lastName: 'Pérez',
  phoneCountryCode: '52',
  phone: '5512345678',
  isTrusted: true,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  priceList: null,
};

function build(
  store: Partial<ChatbotRequestReadStore>,
  pauseReader?: SlaPauseReader,
) {
  const full = {
    tenantId: () => TENANT,
    customers: jest.fn().mockResolvedValue([]),
    ...store,
  } as ChatbotRequestReadStore;
  return new ChatbotRequestReadsService(full, sealer, () => NOW, pauseReader);
}

type ListCall = [
  { filters: Record<string, unknown>; customerKey: string; tab: string },
];

describe('by-customer list takes the filters of the groups (S9 item 1)', () => {
  const run = async (
    ability: ReturnType<typeof abilityOf>,
    input: Record<string, unknown>,
  ) => {
    const listByCustomer = jest.fn().mockResolvedValue([]);
    const page = await build({ listByCustomer }).listByCustomer(as(ability), {
      customerKey: sealer.seal(TENANT, KEY),
      tab: 'open',
      ...input,
    });
    return { listByCustomer, page };
  };

  it('hands subtype, assignee, overdue and windowClosingSoon to the store, and the key opened', async () => {
    const { listByCustomer } = await run(CASHIER, {
      filters: {
        subtype: 'COMPLAINT',
        assignee: { kind: 'unassigned' },
        overdue: true,
        windowClosingSoon: true,
      },
    });
    const [query] = (listByCustomer.mock.calls as ListCall[])[0];
    expect(query.customerKey).toBe(KEY);
    expect(query.filters).toEqual({
      subtype: 'COMPLAINT',
      assignee: { kind: 'unassigned' },
      overdue: true,
      windowClosingSoon: true,
    });
  });

  it('no filters means the filters the list always had: none', async () => {
    const { listByCustomer } = await run(CASHIER, {});
    expect((listByCustomer.mock.calls as ListCall[])[0][0].filters).toEqual({});
  });

  it('parses q with the same rules: folio and name for everyone', async () => {
    const folio = await run(CASHIER, { q: 'S-000123' });
    expect(
      (folio.listByCustomer.mock.calls as ListCall[])[0][0].filters,
    ).toMatchObject({ search: { kind: 'folio', folio: 123 } });
    const name = await run(CASHIER, { q: 'María', filters: { overdue: true } });
    expect(
      (name.listByCustomer.mock.calls as ListCall[])[0][0].filters,
    ).toEqual({
      overdue: true,
      search: { kind: 'name', tokens: ['maria'] },
    });
  });

  it('R12: digits without read:CustomerPhone do not even query (no phone oracle)', async () => {
    const denied = await run(CASHIER, { q: '5512345678' });
    expect(denied.listByCustomer).not.toHaveBeenCalled();
    expect(denied.page).toEqual({ items: [], nextCursor: null });
    const allowed = await run(MANAGER, { q: '55 1234' });
    expect(
      (allowed.listByCustomer.mock.calls as ListCall[])[0][0].filters,
    ).toEqual({ search: { kind: 'phone', digits: '551234' } });
  });

  it('an empty q is no search', async () => {
    const { listByCustomer } = await run(CASHIER, { q: '  ' });
    expect((listByCustomer.mock.calls as ListCall[])[0][0].filters).toEqual({});
  });

  it('a foreign customerKey is still a 400 before any query, filters or not', async () => {
    const listByCustomer = jest.fn().mockResolvedValue([]);
    await expect(
      build({ listByCustomer }).listByCustomer(as(CASHIER), {
        customerKey: 'not-a-token',
        tab: 'open',
        q: '5512345678',
        filters: { overdue: true },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(listByCustomer).not.toHaveBeenCalled();
  });
});

describe('counts.unassigned (S9 item 2)', () => {
  it('passes the store counts through, new key included', async () => {
    const counts = {
      new: 3,
      inProgress: 1,
      mine: 1,
      overdue: 0,
      windowClosingSoon: 0,
      scheduled: 0,
      needsReschedule: 0,
      resolved7d: 0,
      cancelled7d: 0,
      openGroups: 2,
      unassigned: 3,
    };
    const store = { counts: jest.fn().mockResolvedValue(counts) };
    await expect(build(store).counts(as(CASHIER))).resolves.toEqual(counts);
    expect(store.counts).toHaveBeenCalledWith('u-me', NOW);
  });
});

describe('overdueCount on every group (S9 item 3)', () => {
  const groups = (list: GroupRecord[]) =>
    build({ groups: jest.fn().mockResolvedValue(list) }).groups(as(CASHIER), {
      tab: 'open',
      filters: {},
    });
  const group = (over: Partial<GroupRecord> = {}): GroupRecord => ({
    customerKey: KEY,
    mostUrgentAt: null,
    openCount: 12,
    lastClosedAt: null,
    moreRequests: 2,
    requests: [record()],
    ...over,
  });

  it('is the store count, not the number of overdue rows loaded', async () => {
    const page = await groups([
      group({
        overdueCount: 7,
        requests: [record({ overdueAt: NOW })],
      }),
    ]);
    expect(page.items[0].overdueCount).toBe(7);
    expect(page.items[0].requests).toHaveLength(1);
  });

  it('reads 0 when the store has none (never undefined, never null)', async () => {
    const page = await groups([
      group({ overdueCount: 0 }),
      group({ customerKey: '525599999999' }),
    ]);
    expect(page.items.map((g) => g.overdueCount)).toEqual([0, 0]);
  });
});

describe('history rows carry the customer (S9 item 4)', () => {
  const closed = (over: Partial<RequestRecord> = {}) =>
    record({
      status: 'RESOLVED',
      version: 3,
      closedAt: new Date('2026-10-01T10:00:00-06:00'),
      ...over,
    });
  const history = (
    ability: ReturnType<typeof abilityOf>,
    rows: RequestRecord[],
    customers: CustomerRecord[] = [customer],
  ) => {
    const store = {
      history: jest.fn().mockResolvedValue(rows),
      customers: jest.fn().mockResolvedValue(customers),
    };
    return {
      store,
      run: () => build(store).history(as(ability), {}),
    };
  };

  it('has the name, and the phone only through toStaffPhone, like a group row', async () => {
    const rows = [closed({ customerId: 'c-1' })];
    const cashier = await history(CASHIER, rows).run();
    expect(cashier.items[0].customer).toEqual({
      id: 'c-1',
      displayName: 'Juan Pérez',
      phone: '55 **** 5678',
      isTrusted: true,
    });
    const manager = await history(MANAGER, rows).run();
    expect(manager.items[0].customer.phone).toBe('+525512345678');
    expect(JSON.stringify(cashier)).not.toContain(KEY);
    expect(JSON.stringify(cashier)).not.toContain('5512345678');
    // sealed key unchanged
    expect(cashier.items[0].customerKey).toBe(sealer.seal(TENANT, KEY));
  });

  it('a request with no linked customer has a null name and a masked phone', async () => {
    const page = await history(CASHIER, [closed()]).run();
    expect(page.items[0].customer).toEqual({
      id: null,
      displayName: null,
      phone: '55 **** 5678',
      isTrusted: false,
    });
  });

  it('looks the customers of the page up once, never per row, and not at all for none', async () => {
    const { store, run } = history(CASHIER, [
      closed({ id: 'a', customerId: 'c-1' }),
      closed({ id: 'b', customerId: 'c-1' }),
      closed({ id: 'c' }),
    ]);
    await run();
    expect(store.customers).toHaveBeenCalledTimes(1);
    expect(store.customers).toHaveBeenCalledWith(['c-1']);
    const none = history(CASHIER, [closed()]);
    await none.run();
    expect(none.store.customers).not.toHaveBeenCalled();
  });

  it('keeps every column history rows already had', async () => {
    const page = await history(CASHIER, [closed({ customerId: 'c-1' })]).run();
    const row: Record<string, unknown> = page.items[0];
    for (const key of [
      'id',
      'folio',
      'customerKey',
      'status',
      'closedAt',
      'resolvedBy',
      'cancelReason',
      'allowedActions',
      'deniedActions',
    ]) {
      expect(row).toHaveProperty(key);
    }
  });
});

describe('realtime rows stay consistent with the inbox rows (S9 item 5)', () => {
  const pauseReader: SlaPauseReader = {
    pauseAt: () => Promise.resolve({ paused: false, resumesAt: null }),
    viewAt: () =>
      Promise.resolve({
        pause: { paused: false, resumesAt: null },
        level: (anchors) =>
          slaLevel(policyFromSettings(defaultSettings(), 1), anchors, NOW),
      }),
  };

  it('the request row has the keys of a list row; the customer card is the one a history row has', async () => {
    const row = record({ id: 'r-9', customerId: 'c-1' });
    const service = build(
      {
        byIds: jest.fn().mockResolvedValue([row]),
        customers: jest.fn().mockResolvedValue([customer]),
        history: jest.fn().mockResolvedValue([
          {
            ...row,
            status: 'RESOLVED',
            version: 3,
            closedAt: new Date('2026-10-01T10:00:00-06:00'),
          },
        ]),
      },
      pauseReader,
    );
    const reader = as(CASHIER);
    const batch = await service.loadEventRows(['r-9']);
    const shaped = service.shapeEventRow(batch, 'r-9', reader);
    const past = await service.history(reader, {});
    expect(shaped).not.toBeNull();
    // No new realtime field was added to the request row: the customer card
    // stays its sibling, exactly as before, and has the history row's shape.
    expect(Object.keys(shaped!.request).sort()).toEqual(
      Object.keys(past.items[0])
        .filter((key) => key !== 'customer')
        .sort(),
    );
    expect(shaped!.customer).toEqual(past.items[0].customer);
    expect(Object.keys(shaped!)).toEqual([
      'request',
      'customer',
      'previousCustomerKey',
    ]);
  });
});
