/**
 * S8 additions to the staff reads (unit 4): per-row `allowedActions` /
 * `deniedActions`, close cause (`cancelReason`, `staffCancelReason`,
 * `mergedInto`), `slaLevel`, and the three new counts. The pre-S8 specs
 * (`chatbot-request-reads.service.spec.ts`) are not touched.
 */
import { Logger } from '@nestjs/common';
import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { policyFromSettings, slaLevel } from '../domain/chatbot-sla';
import { CustomerKeySealer } from '../domain/customer-key-sealer';
import {
  ChatbotRequestReadsService,
  type ChatbotRequestReadStore,
  type DetailRecord,
  type GroupRecord,
  type RequestRecord,
  type SlaPauseReader,
} from './chatbot-request-reads.service';

const TENANT = 'tenant-1';
const NOW = new Date('2026-11-10T10:20:00-06:00');
const KEY = '525512345678';
const sealer = new CustomerKeySealer('unit-secret-of-some-length');
const ME = 'u-me';

type Grant = string;
const abilityOf = (...grants: Grant[]) => ({
  can: (action: string, subject: string) =>
    grants.includes(`${action}:${subject}`),
});
const CASHIER = abilityOf('read:ChatbotRequest', 'update:ChatbotRequest');
const MANAGER = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
  'update:ChatbotRequestAssignment',
  'update:HumanDecision',
  'validate:DeliveryZone',
  'update:ReceiptEvidence',
);
const READ_ONLY = abilityOf('read:ChatbotRequest');
const as = (ability: ReturnType<typeof abilityOf>) => ({
  userId: ME,
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
const closedRecord = (over: Partial<RequestRecord> = {}) =>
  record({
    status: 'CANCELLED',
    version: 4,
    closedAt: new Date('2026-11-10T10:10:00-06:00'),
    ...over,
  });

const group = (requests: RequestRecord[]): GroupRecord => ({
  customerKey: KEY,
  mostUrgentAt: null,
  openCount: requests.length,
  lastClosedAt: null,
  moreRequests: 0,
  requests,
});

const policy = policyFromSettings(defaultSettings(), 1);
/** The real pause reader's contract: one policy, pause + level. */
const reader = (): SlaPauseReader => ({
  pauseAt: jest.fn().mockResolvedValue({ paused: false, resumesAt: null }),
  viewAt: jest.fn().mockResolvedValue({
    pause: { paused: false, resumesAt: null },
    level: (anchors: Parameters<typeof slaLevel>[1]) =>
      slaLevel(policy, anchors, NOW),
  }),
});

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

describe('rows: allowedActions and deniedActions (S8 item 1 and 4)', () => {
  const rows = async (
    requests: RequestRecord[],
    ability: ReturnType<typeof abilityOf>,
  ) => {
    const page = await build({
      groups: jest.fn().mockResolvedValue([group(requests)]),
    }).groups(as(ability), { tab: 'open', filters: {} });
    return page.items[0].requests;
  };

  it('every row of a group carries both lists, computed from its own state and the caller', async () => {
    const mine = record({
      id: 'r-mine',
      status: 'IN_PROGRESS',
      assigneeUserId: ME,
      assigneeDisplayName: 'Yo',
    });
    const theirs = record({
      id: 'r-theirs',
      status: 'IN_PROGRESS',
      assigneeUserId: 'u-ana',
      assigneeDisplayName: 'Ana',
    });
    const [a, b, c] = await rows([record(), mine, theirs], CASHIER);
    expect(a.allowedActions).toEqual(['CLAIM', 'CANCEL']);
    expect(a.deniedActions).toEqual([]);
    expect(b.allowedActions).toEqual(['RELEASE', 'CANCEL']);
    expect(c.allowedActions).toEqual([]);
    expect(c.deniedActions).toEqual([
      { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
      { action: 'RELEASE', code: 'NOT_ASSIGNEE' },
      { action: 'REASSIGN', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'NOT_ASSIGNEE' },
    ]);
  });

  it('a row never shows MERGE or LINK_CUSTOMER, even for a manager with candidates around', async () => {
    const [row] = await rows([record()], MANAGER);
    expect(row.allowedActions).toEqual(['CLAIM', 'CANCEL']);
    const all = JSON.stringify([row.allowedActions, row.deniedActions]);
    expect(all).not.toContain('MERGE');
    expect(all).not.toContain('LINK_CUSTOMER');
  });

  it('a read-only caller gets no allowed action and a permission code for what applies', async () => {
    const [row] = await rows([record()], READ_ONLY);
    expect(row.allowedActions).toEqual([]);
    expect(row.deniedActions).toEqual([
      { action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'INSUFFICIENT_PERMISSIONS' },
    ]);
  });

  it('RESOLVE on DELIVERY_ZONE follows the detail rule: only when the zone has a validation', async () => {
    const zone = (zoneHasValidation: boolean | null | undefined) =>
      record({
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE',
        zoneHasValidation,
      });
    const [withValidation, without, unknown] = await rows(
      [zone(true), zone(false), zone(undefined)],
      MANAGER,
    );
    expect(withValidation.allowedActions).toContain('RESOLVE');
    expect(without.allowedActions).not.toContain('RESOLVE');
    expect(without.deniedActions.map((d) => d.action)).not.toContain('RESOLVE');
    // Unknown means conservative: not offered.
    expect(unknown.allowedActions).not.toContain('RESOLVE');
  });

  it('closed rows have empty lists (history included)', async () => {
    const page = await build({
      history: jest.fn().mockResolvedValue([closedRecord()]),
    }).history(as(MANAGER), {});
    expect(page.items[0]).toMatchObject({
      allowedActions: [],
      deniedActions: [],
    });
  });

  it('by-customer rows and the detail’s other open rows carry the lists too', async () => {
    const list = await build({
      listByCustomer: jest.fn().mockResolvedValue([record()]),
    }).listByCustomer(as(MANAGER), {
      customerKey: sealer.seal(TENANT, KEY),
      tab: 'open',
    });
    expect(list.items[0].allowedActions).toEqual(['CLAIM', 'CANCEL']);
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
      otherOpen: [record({ id: 'r-2' })],
      decision: null,
      zoneImpact: null,
      audit: [],
      deliveries: [],
    };
    const out = await build({
      findDetail: jest.fn().mockResolvedValue(detail),
    }).detail(as(MANAGER), 'r-1');
    expect(out.otherOpenRequests[0].allowedActions).toEqual([
      'CLAIM',
      'CANCEL',
    ]);
    expect(out.allowedActions).toEqual(['CLAIM', 'CANCEL']);
    expect(out.deniedActions).toEqual([]);
  });

  it('detail: deniedActions come from the same evaluation (MERGE / LINK_CUSTOMER included)', async () => {
    const detail: DetailRecord = {
      request: {
        ...record(),
        needs: null,
        context: null,
        resolution: null,
        resolvedAt: null,
        ambiguousCustomer: true,
      },
      candidates: [],
      hasMergeCandidate: true,
      customer: null,
      recentOrders: [],
      otherOpen: [],
      decision: null,
      zoneImpact: null,
      audit: [],
      deliveries: [],
    };
    const out = await build({
      findDetail: jest.fn().mockResolvedValue(detail),
    }).detail(as(READ_ONLY), 'r-1');
    expect(out.deniedActions).toEqual([
      { action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'MERGE', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'INSUFFICIENT_PERMISSIONS' },
    ]);
  });

  it('merge-candidates rows carry the lists when the caller is passed', async () => {
    const service = build({
      mergeCandidates: jest.fn().mockResolvedValue([record({ id: 'r-2' })]),
    });
    const withReader = await service.mergeCandidates('r-1', as(MANAGER));
    expect(withReader.items[0].allowedActions).toEqual(['CLAIM', 'CANCEL']);
  });
});

describe('rows: close cause (S8 item 3)', () => {
  const one = async (r: RequestRecord) =>
    (
      await build({
        history: jest.fn().mockResolvedValue([r]),
      }).history(as(MANAGER), {})
    ).items[0];

  it('open rows have null cause and mergedInto', async () => {
    const page = await build({
      groups: jest.fn().mockResolvedValue([group([record()])]),
    }).groups(as(MANAGER), { tab: 'open', filters: {} });
    expect(page.items[0].requests[0]).toMatchObject({
      cancelReason: null,
      staffCancelReason: null,
      mergedInto: null,
    });
  });

  it('a resolved row has no cancel cause', async () => {
    expect(
      await one(closedRecord({ status: 'RESOLVED', cancelReason: null })),
    ).toMatchObject({
      cancelReason: null,
      staffCancelReason: null,
      mergedInto: null,
    });
  });

  it('customer causes carry no staff reason', async () => {
    for (const cancelReason of [
      'CUSTOMER_WITHDREW',
      'AUTO_RESOLVED',
    ] as const) {
      expect(await one(closedRecord({ cancelReason }))).toMatchObject({
        cancelReason,
        staffCancelReason: null,
        mergedInto: null,
      });
    }
  });

  it('STAFF carries the staff reason and never a note', async () => {
    const row = await one(
      closedRecord({
        cancelReason: 'STAFF',
        staffCancelReason: 'OTHER',
        // A leak guard: whatever a store might attach, a note never leaves.
        ...({ note: 'nota interna', customerNote: 'hola' } as object),
      }),
    );
    expect(row).toMatchObject({
      cancelReason: 'STAFF',
      staffCancelReason: 'OTHER',
    });
    expect(JSON.stringify(row)).not.toContain('nota interna');
    expect(JSON.stringify(row)).not.toContain('hola');
  });

  it('SUPERSEDED by a staff merge names the target: id and formatted folio', async () => {
    const row = await one(
      closedRecord({
        cancelReason: 'SUPERSEDED',
        mergedInto: { id: 'r-target', folio: 77 },
      }),
    );
    expect(row.cancelReason).toBe('SUPERSEDED');
    expect(row.mergedInto).toEqual({ id: 'r-target', folio: 'S-000077' });
  });

  it('SUPERSEDED with no readable MERGED event is null, not an error', async () => {
    expect(
      await one(closedRecord({ cancelReason: 'SUPERSEDED', mergedInto: null })),
    ).toMatchObject({ cancelReason: 'SUPERSEDED', mergedInto: null });
    expect(
      await one(
        closedRecord({
          cancelReason: 'SUPERSEDED',
          mergedInto: { id: 5, folio: 'x' } as never,
        }),
      ),
    ).toMatchObject({ mergedInto: null });
  });

  it('the detail has the same fields', async () => {
    const detail: DetailRecord = {
      request: {
        ...closedRecord({
          cancelReason: 'SUPERSEDED',
          mergedInto: { id: 'r-target', folio: 77 },
        }),
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
      audit: [],
      deliveries: [],
    };
    const out = await build({
      findDetail: jest.fn().mockResolvedValue(detail),
    }).detail(as(MANAGER), 'r-1');
    expect(out).toMatchObject({
      cancelReason: 'SUPERSEDED',
      staffCancelReason: null,
      mergedInto: { id: 'r-target', folio: 'S-000077' },
    });
  });
});

describe('rows: slaLevel (S8 item 5)', () => {
  const page = async (
    r: RequestRecord,
    pauseReader: SlaPauseReader | null = reader(),
  ) =>
    (
      await build(
        { groups: jest.fn().mockResolvedValue([group([r])]) },
        pauseReader ?? undefined,
      ).groups(as(MANAGER), { tab: 'open', filters: {} })
    ).items[0].requests[0];

  it('is the level of the active clock at the read instant', async () => {
    // NOW is 20 min into a 30 min claim window: past 50 %, past 80 % (24 min)? no.
    expect((await page(record())).slaLevel).toBe('HALF');
    expect(
      (await page(record({ createdAt: new Date('2026-11-10T10:10:00-06:00') })))
        .slaLevel,
    ).toBe('OK');
    expect(
      (await page(record({ createdAt: new Date('2026-11-10T09:55:00-06:00') })))
        .slaLevel,
    ).toBe('ESCALATION');
    expect(
      (await page(record({ createdAt: new Date('2026-11-10T09:30:00-06:00') })))
        .slaLevel,
    ).toBe('OVERDUE');
  });

  it('a claimed request is measured on the resolve clock', async () => {
    expect(
      (
        await page(
          record({
            status: 'IN_PROGRESS',
            assigneeUserId: ME,
            assigneeDisplayName: 'Yo',
          }),
        )
      ).slaLevel,
    ).toBe('OK');
  });

  it('a release restarts the claim clock (lastReleasedAt)', async () => {
    expect(
      (
        await page(
          record({
            createdAt: new Date('2026-11-10T09:00:00-06:00'),
            lastReleasedAt: new Date('2026-11-10T10:18:00-06:00'),
          }),
        )
      ).slaLevel,
    ).toBe('OK');
  });

  it('is null for closed rows, with no deadline, and without a reader', async () => {
    const closed = await build({
      history: jest.fn().mockResolvedValue([closedRecord()]),
    }).history(as(MANAGER), {});
    expect(closed.items[0].slaLevel).toBeNull();
    expect(
      (
        await page(
          record({
            kind: 'CONVERSATION',
            subtype: 'TALK_TO_HUMAN',
            status: 'IN_PROGRESS',
            assigneeUserId: ME,
            assigneeDisplayName: 'Yo',
          }),
        )
      ).slaLevel,
    ).toBeNull();
    expect((await page(record(), null)).slaLevel).toBeNull();
    // A reader without `viewAt` (the pre-S8 port) also reads as null.
    expect(
      (
        await page(record(), {
          pauseAt: jest
            .fn()
            .mockResolvedValue({ paused: false, resumesAt: null }),
        })
      ).slaLevel,
    ).toBeNull();
  });

  describe('overdueAt forces OVERDUE on open rows', () => {
    const overdueAt = new Date('2026-11-10T10:30:00-06:00');
    const claimedLate = () =>
      record({
        status: 'IN_PROGRESS',
        assigneeUserId: ME,
        assigneeDisplayName: 'Yo',
        overdueAt,
      });

    it('a late claim reads OVERDUE even though the resolve clock is early (and displayStatus is EXPIRED)', async () => {
      const row = await page(claimedLate());
      expect(row.slaLevel).toBe('OVERDUE');
      expect(row.displayStatus).toBe('EXPIRED');
    });

    it('holds without a policy: no reader, an old-port reader and a failed lookup', async () => {
      expect((await page(claimedLate(), null)).slaLevel).toBe('OVERDUE');
      expect(
        (
          await page(claimedLate(), {
            pauseAt: jest
              .fn()
              .mockResolvedValue({ paused: false, resumesAt: null }),
          })
        ).slaLevel,
      ).toBe('OVERDUE');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const broken: SlaPauseReader = {
        pauseAt: jest.fn(),
        viewAt: jest.fn().mockRejectedValue(new TypeError('x')),
      };
      expect((await page(claimedLate(), broken)).slaLevel).toBe('OVERDUE');
      warn.mockRestore();
    });

    it('closed rows stay null even with overdueAt, and open rows without it use the clock', async () => {
      const closed = await build({
        history: jest
          .fn()
          .mockResolvedValue([closedRecord({ overdueAt, status: 'RESOLVED' })]),
      }).history(as(MANAGER), {});
      expect(closed.items[0].slaLevel).toBeNull();
      expect((await page(record())).slaLevel).toBe('HALF');
    });
  });

  it('fails soft: a failed policy lookup gives null levels, not paused, and logs once by tenant', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const broken: SlaPauseReader = {
      pauseAt: jest.fn(),
      viewAt: jest.fn().mockRejectedValue(new TypeError('secret settings')),
    };
    const out = await build(
      {
        groups: jest
          .fn()
          .mockResolvedValue([group([record(), record({ id: 'r-2' })])]),
      },
      broken,
    ).groups(as(MANAGER), { tab: 'open', filters: {} });
    expect(out.items[0].requests.map((r) => r.slaLevel)).toEqual([null, null]);
    expect(out.items[0].requests[0]).toMatchObject({ slaPaused: false });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(TENANT);
    expect(line).not.toContain('secret settings');
    warn.mockRestore();
  });

  it('a per-row failure gives null for that row and one log per call', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const flaky: SlaPauseReader = {
      pauseAt: jest.fn(),
      viewAt: jest.fn().mockResolvedValue({
        pause: { paused: false, resumesAt: null },
        level: () => {
          throw new TypeError('boom');
        },
      }),
    };
    const out = await build(
      {
        groups: jest
          .fn()
          .mockResolvedValue([group([record(), record({ id: 'r-2' })])]),
      },
      flaky,
    ).groups(as(MANAGER), { tab: 'open', filters: {} });
    expect(out.items[0].requests.map((r) => r.slaLevel)).toEqual([null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('uses the pause of the same lookup (slaPaused stays derived)', async () => {
    const pauseAt = jest.fn();
    const paused: SlaPauseReader = {
      pauseAt,
      viewAt: jest.fn().mockResolvedValue({
        pause: {
          paused: true,
          resumesAt: new Date('2026-11-11T15:00:00.000Z'),
        },
        level: () => 'OK',
      }),
    };
    const row = await page(record(), paused);
    expect(row).toMatchObject({
      slaPaused: true,
      slaResumesAt: '2026-11-11T15:00:00.000Z',
      slaLevel: 'OK',
    });
    expect(pauseAt).not.toHaveBeenCalled();
  });
});

describe('counts (S8 item 2)', () => {
  it('passes the three new counts through with the old ones', async () => {
    const counts = {
      new: 1,
      inProgress: 2,
      mine: 1,
      overdue: 0,
      windowClosingSoon: 0,
      scheduled: 0,
      needsReschedule: 0,
      resolved7d: 5,
      cancelled7d: 3,
      openGroups: 2,
    };
    const store = { counts: jest.fn().mockResolvedValue(counts) };
    await expect(build(store).counts(as(CASHIER))).resolves.toEqual(counts);
    expect(store.counts).toHaveBeenCalledWith(ME, NOW);
  });
});
