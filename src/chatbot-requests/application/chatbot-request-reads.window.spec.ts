/**
 * T7g (S11): every row of the staff reads carries `windowClosingSoon`, the rule
 * of the filter (`window-closing-soon.ts`) with the tenant's
 * `windowWarningMinutes`, read ONCE per call (no N+1). Closed rows and rows
 * with no window read false. The realtime row is the inbox row, so it carries
 * it too.
 */
import { CustomerKeySealer } from '../domain/customer-key-sealer';
import {
  ChatbotRequestReadsService,
  type ChatbotRequestReadStore,
  type DetailRecord,
  type GroupRecord,
  type RequestRecord,
} from './chatbot-request-reads.service';

const TENANT = 'tenant-1';
const MIN = 60_000;
const NOW = new Date('2026-11-12T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
const KEY = '525512345678';
const sealer = new CustomerKeySealer('unit-secret-of-some-length');

const abilityOf = (...grants: string[]) => ({
  can: (action: string, subject: string) =>
    grants.includes(`${action}:${subject}`),
});
const MANAGER = {
  userId: 'u-me',
  ability: abilityOf(
    'read:ChatbotRequest',
    'update:ChatbotRequest',
    'read:CustomerPhone',
  ),
};

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r-1',
  folio: 1,
  kind: 'CONVERSATION',
  subtype: 'TALK_TO_HUMAN',
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
  summary: 'x',
  createdAt: new Date('2026-11-12T10:00:00Z'),
  closedAt: null,
  resolvedByActorId: null,
  resolvedByDisplayName: null,
  urgencyAt: null,
  ...over,
});

/** 30 min: soon at 60 and 120. 90 min: soon only at 120. 200 min: never. */
const SOON_60_AND_120 = record({
  id: 'r-30',
  whatsappWindowClosesAt: at(30),
});
const SOON_ONLY_120 = record({ id: 'r-90', whatsappWindowClosesAt: at(90) });
const FAR = record({ id: 'r-200', whatsappWindowClosesAt: at(200) });
const CLOSED_WINDOW = record({ id: 'r-gone', whatsappWindowClosesAt: at(-1) });
const NO_WINDOW = record({ id: 'r-none' });
const RESOLVED = record({
  id: 'r-done',
  status: 'RESOLVED',
  closedAt: at(-5),
  whatsappWindowClosesAt: at(30),
});
const ALL = [
  SOON_60_AND_120,
  SOON_ONLY_120,
  FAR,
  CLOSED_WINDOW,
  NO_WINDOW,
  RESOLVED,
];
const EXPECTED_60: Record<string, boolean> = {
  'r-30': true,
  'r-90': false,
  'r-200': false,
  'r-gone': false,
  'r-none': false,
  'r-done': false,
};
const EXPECTED_120: Record<string, boolean> = { ...EXPECTED_60, 'r-90': true };

function build(
  store: Partial<ChatbotRequestReadStore>,
  minutes: number | 'absent',
) {
  const windowWarningMinutes = jest.fn().mockResolvedValue(minutes);
  const full = {
    tenantId: () => TENANT,
    customers: jest.fn().mockResolvedValue([]),
    ...(minutes === 'absent' ? {} : { windowWarningMinutes }),
    ...store,
  } as ChatbotRequestReadStore;
  const service = new ChatbotRequestReadsService(
    full,
    sealer,
    () => NOW,
    undefined,
  );
  return { service, windowWarningMinutes };
}

const flags = (rows: Array<{ id: string; windowClosingSoon: boolean }>) =>
  Object.fromEntries(rows.map((r) => [r.id, r.windowClosingSoon]));

const group = (requests: RequestRecord[]): GroupRecord => ({
  customerKey: KEY,
  mostUrgentAt: null,
  openCount: requests.length,
  overdueCount: 0,
  lastClosedAt: null,
  moreRequests: 0,
  requests,
});

describe.each([
  ['tenant on 60', 60, EXPECTED_60],
  ['tenant on 120', 120, EXPECTED_120],
  ['store that does not say (default 120)', 'absent' as const, EXPECTED_120],
])('windowClosingSoon on rows: %s', (_label, minutes, expected) => {
  it('groups: every row is flagged, one settings read for the whole page', async () => {
    const { service, windowWarningMinutes } = build(
      { groups: jest.fn().mockResolvedValue([group(ALL)]) },
      minutes,
    );
    const page = await service.groups(MANAGER, {
      tab: 'open',
      filters: {},
    });
    expect(flags(page.items[0].requests as never)).toEqual(expected);
    expect(windowWarningMinutes.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('by-customer list', async () => {
    const { service, windowWarningMinutes } = build(
      { listByCustomer: jest.fn().mockResolvedValue(ALL) },
      minutes,
    );
    const page = await service.listByCustomer(MANAGER, {
      customerKey: sealer.seal(TENANT, KEY),
      tab: 'open',
    });
    expect(flags(page.items as never)).toEqual(expected);
    expect(windowWarningMinutes.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('merge candidates', async () => {
    const { service } = build(
      { mergeCandidates: jest.fn().mockResolvedValue(ALL) },
      minutes,
    );
    const page = await service.mergeCandidates('r-x', MANAGER);
    expect(flags(page.items as never)).toEqual(expected);
  });

  it('detail: the request and otherOpenRequests, one settings read', async () => {
    const detail: DetailRecord = {
      request: { ...SOON_ONLY_120, id: 'r-90' } as DetailRecord['request'],
      candidates: [],
      hasMergeCandidate: false,
      customer: null,
      recentOrders: [],
      otherOpen: [SOON_60_AND_120, FAR, NO_WINDOW],
      decision: null,
      zoneImpact: null,
      audit: [],
      deliveries: [],
    };
    const { service, windowWarningMinutes } = build(
      { findDetail: jest.fn().mockResolvedValue(detail) },
      minutes,
    );
    const body = await service.detail(MANAGER, 'r-90');
    expect(body.windowClosingSoon).toBe(expected['r-90']);
    expect(flags(body.otherOpenRequests as never)).toEqual({
      'r-30': true,
      'r-200': false,
      'r-none': false,
    });
    expect(windowWarningMinutes.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('realtime row parity: shapeEventRow carries the same flag as the inbox row', async () => {
    const { service, windowWarningMinutes } = build(
      { byIds: jest.fn().mockResolvedValue(ALL) },
      minutes,
    );
    const batch = await service.loadEventRows(ALL.map((r) => r.id));
    const shaped = ALL.map(
      (r) => service.shapeEventRow(batch, r.id, MANAGER)?.request,
    );
    expect(flags(shaped as never)).toEqual(expected);
    // once per batch, not once per recipient or row
    expect(windowWarningMinutes.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('windowClosingSoon: no needless lookups', () => {
  it('history rows are closed: false, and the settings are not read', async () => {
    const { service, windowWarningMinutes } = build(
      {
        history: jest.fn().mockResolvedValue([RESOLVED]),
      },
      60,
    );
    const page = await service.history(MANAGER, {});
    expect(page.items[0].windowClosingSoon).toBe(false);
    expect(windowWarningMinutes).not.toHaveBeenCalled();
  });

  it('a page with no open row that has a window does not read the settings', async () => {
    const { service, windowWarningMinutes } = build(
      {
        listByCustomer: jest.fn().mockResolvedValue([NO_WINDOW, RESOLVED]),
      },
      60,
    );
    const page = await service.listByCustomer(MANAGER, {
      customerKey: sealer.seal(TENANT, KEY),
      tab: 'open',
    });
    expect(flags(page.items as never)).toEqual({
      'r-none': false,
      'r-done': false,
    });
    expect(windowWarningMinutes).not.toHaveBeenCalled();
  });

  it('with the filter on, the minutes are read once and handed to the store AND used for the rows', async () => {
    const listByCustomer = jest
      .fn()
      .mockResolvedValue([SOON_60_AND_120, SOON_ONLY_120]);
    const { service, windowWarningMinutes } = build({ listByCustomer }, 60);
    const page = await service.listByCustomer(MANAGER, {
      customerKey: sealer.seal(TENANT, KEY),
      tab: 'open',
      filters: { windowClosingSoon: true },
    });
    expect(windowWarningMinutes).toHaveBeenCalledTimes(1);
    expect(listByCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ windowWarningMinutes: 60 }),
    );
    // The store would not return r-90 at 60; the fake does, the row says false.
    expect(flags(page.items as never)).toEqual({ 'r-30': true, 'r-90': false });
  });

  it('with the filter on and the groups tab, one read too', async () => {
    const groups = jest.fn().mockResolvedValue([group([SOON_60_AND_120])]);
    const { service, windowWarningMinutes } = build({ groups }, 60);
    await service.groups(MANAGER, {
      tab: 'open',
      filters: { windowClosingSoon: true },
    });
    expect(windowWarningMinutes).toHaveBeenCalledTimes(1);
    expect(groups).toHaveBeenCalledWith(
      expect.objectContaining({ windowWarningMinutes: 60 }),
    );
  });
});
