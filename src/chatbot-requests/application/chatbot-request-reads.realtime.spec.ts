/**
 * Unit 8: the rows of the realtime request events are built by the same code
 * as the inbox rows, once per batch and then per recipient (R12): the phone
 * goes through `toStaffPhone`, `customerKey` and `previousCustomerKey` through
 * `CustomerKeySealer`, and a recipient who cannot read requests gets nothing.
 */
import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { policyFromSettings, slaLevel } from '../domain/chatbot-sla';
import { CustomerKeySealer } from '../domain/customer-key-sealer';
import {
  ChatbotRequestReadsService,
  type ChatbotRequestReadStore,
  type CustomerRecord,
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
const MANAGER = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
  'update:ChatbotRequestAssignment',
  'read:CustomerPhone',
);
const CASHIER = abilityOf('read:ChatbotRequest', 'update:ChatbotRequest');
const NOBODY = abilityOf('update:ChatbotRequest');
const as = (userId: string, ability: ReturnType<typeof abilityOf>) => ({
  userId,
  ability,
});

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r-1',
  folio: 123,
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'IN_PROGRESS',
  version: 4,
  customerKey: KEY,
  customerId: null,
  phoneCountryCode: '52',
  phone: '5512345678',
  assigneeUserId: 'u-ana',
  assigneeDisplayName: 'Ana',
  claimedAt: new Date('2026-11-10T10:05:00-06:00'),
  claimDeadlineAt: null,
  resolveDeadlineAt: new Date('2026-11-10T12:00:00-06:00'),
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

const policy = policyFromSettings(defaultSettings(), 1);
const pauseReader = (): SlaPauseReader => ({
  pauseAt: jest.fn().mockResolvedValue({ paused: false, resumesAt: null }),
  viewAt: jest.fn().mockResolvedValue({
    pause: { paused: false, resumesAt: null },
    level: (anchors: Parameters<typeof slaLevel>[1]) =>
      slaLevel(policy, anchors, NOW),
  }),
});

function build(
  rows: RequestRecord[],
  customers: CustomerRecord[] = [],
  pause: SlaPauseReader | undefined = pauseReader(),
) {
  const store: { tenantId: () => string; [k: string]: unknown } = {
    tenantId: () => TENANT,
    byIds: jest.fn().mockResolvedValue(rows),
    customers: jest.fn().mockResolvedValue(customers),
  };
  const service = new ChatbotRequestReadsService(
    store as unknown as ChatbotRequestReadStore,
    sealer,
    () => NOW,
    pause,
  );
  return { service, store };
}

describe('realtime request rows (unit 8)', () => {
  it('loads each request, customer and policy once for the whole batch', async () => {
    const { service, store } = build(
      [record(), record({ id: 'r-2', customerId: 'c-1' })],
      [customer],
    );
    const batch = await service.loadEventRows(['r-1', 'r-2', 'r-1']);
    expect(store.byIds).toHaveBeenCalledTimes(1);
    expect(store.byIds).toHaveBeenCalledWith(['r-1', 'r-2']);
    expect(store.customers).toHaveBeenCalledTimes(1);
    const first = service.shapeEventRow(batch, 'r-1', as('u-1', MANAGER));
    const second = service.shapeEventRow(batch, 'r-2', as('u-2', CASHIER));
    expect(first?.request.id).toBe('r-1');
    expect(second?.request.id).toBe('r-2');
    expect(store.byIds).toHaveBeenCalledTimes(1);
  });

  it('shapes the same row as the inbox: version, SLA fields and actions', async () => {
    const { service } = build([record()]);
    const batch = await service.loadEventRows(['r-1']);
    const shaped = service.shapeEventRow(batch, 'r-1', as('u-ana', CASHIER));
    expect(shaped?.request).toMatchObject({
      id: 'r-1',
      folio: 'S-000123',
      status: 'IN_PROGRESS',
      version: 4,
      assignee: { id: 'u-ana', displayName: 'Ana' },
      slaPaused: false,
      slaLevel: expect.stringMatching(/OK|HALF|ESCALATION|OVERDUE/) as string,
      cancelReason: null,
    });
    // Ana holds it: she may release it; a stranger may not.
    expect(shaped?.request.allowedActions).toContain('RELEASE');
    const other = service.shapeEventRow(batch, 'r-1', as('u-other', CASHIER));
    expect(other?.request.allowedActions).not.toContain('RELEASE');
    expect(other?.request.deniedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'RELEASE' }) as unknown,
      ]),
    );
  });

  it('masks the phone per recipient and never sends the raw customerKey (R12)', async () => {
    const { service } = build([record({ customerId: 'c-1' })], [customer]);
    const batch = await service.loadEventRows(['r-1']);
    const manager = service.shapeEventRow(batch, 'r-1', as('u-m', MANAGER));
    const cashier = service.shapeEventRow(batch, 'r-1', as('u-c', CASHIER));
    expect(manager?.customer).toMatchObject({
      id: 'c-1',
      displayName: 'Juan Pérez',
      phone: '+525512345678',
      isTrusted: true,
    });
    expect(cashier?.customer.phone).toBe('55 **** 5678');
    // Same opaque token for both roles, bound to the tenant, never the phone.
    expect(manager?.request.customerKey).toBe(cashier?.request.customerKey);
    expect(manager?.request.customerKey).toBe(sealer.seal(TENANT, KEY));
    expect(manager?.request.customerKey.startsWith('k1.')).toBe(true);
    expect(JSON.stringify(cashier)).not.toContain(KEY);
    // The full number appears only for the role with read:CustomerPhone.
    expect(JSON.stringify(manager)).toContain('5512345678');
    expect(JSON.stringify(cashier)).not.toContain('5512345678');
    expect(JSON.stringify(cashier)).not.toMatch(/\d{10,}/);
  });

  it('seals previousCustomerKey and leaves it null when there is none', async () => {
    const { service } = build([record()]);
    const batch = await service.loadEventRows(['r-1']);
    const moved = service.shapeEventRow(
      batch,
      'r-1',
      as('u-1', CASHIER),
      '525500000000',
    );
    expect(moved?.previousCustomerKey).toBe(
      sealer.seal(TENANT, '525500000000'),
    );
    expect(JSON.stringify(moved)).not.toContain('525500000000');
    const plain = service.shapeEventRow(batch, 'r-1', as('u-1', CASHIER));
    expect(plain?.previousCustomerKey).toBeNull();
  });

  it('gives a recipient who cannot read requests nothing', async () => {
    const { service } = build([record()]);
    const batch = await service.loadEventRows(['r-1']);
    expect(service.shapeEventRow(batch, 'r-1', as('u-x', NOBODY))).toBeNull();
  });

  it('skips a request that no longer exists in the tenant', async () => {
    const { service } = build([]);
    const batch = await service.loadEventRows(['gone']);
    expect(service.shapeEventRow(batch, 'gone', as('u-1', MANAGER))).toBeNull();
  });

  it('keeps working when the policy cannot be read (levels read as null)', async () => {
    const failing: SlaPauseReader = {
      pauseAt: jest.fn().mockRejectedValue(new Error('boom')),
      viewAt: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { service } = build([record()], [], failing);
    const batch = await service.loadEventRows(['r-1']);
    const shaped = service.shapeEventRow(batch, 'r-1', as('u-1', CASHIER));
    expect(shaped?.request).toMatchObject({ slaPaused: false, slaLevel: null });
  });

  it('an overdue open request is OVERDUE without needing the policy', async () => {
    const { service } = build([
      record({ overdueAt: new Date('2026-11-10T11:00:00-06:00') }),
    ]);
    const batch = await service.loadEventRows(['r-1']);
    expect(
      service.shapeEventRow(batch, 'r-1', as('u-1', CASHIER))?.request,
    ).toMatchObject({ slaLevel: 'OVERDUE', displayStatus: 'EXPIRED' });
  });

  it('seals with the tenant the batch was loaded for, never the ambient one', async () => {
    // `shapeEventRow` runs outside the tenant's CLS scope (after the batch was
    // loaded): whatever tenant happens to be ambient there must not matter.
    let ambient = TENANT;
    const { service, store } = build([
      record({ customerKey: KEY }),
      record({ id: 'r-2', customerKey: KEY }),
    ]);
    store.tenantId = () => ambient;
    const batch = await service.loadEventRows(['r-1', 'r-2']);
    ambient = 'some-other-tenant';
    const shaped = service.shapeEventRow(
      batch,
      'r-1',
      as('u-1', CASHIER),
      '525500000000',
    );
    expect(sealer.open(TENANT, shaped?.request.customerKey ?? '')).toBe(KEY);
    expect(
      sealer.open('some-other-tenant', shaped?.request.customerKey ?? ''),
    ).toBeNull();
    expect(sealer.open(TENANT, shaped?.previousCustomerKey ?? '')).toBe(
      '525500000000',
    );
  });

  it('an empty batch costs no query at all', async () => {
    const { service, store } = build([]);
    const batch = await service.loadEventRows([]);
    expect(batch.rows.size).toBe(0);
    expect(store.byIds).not.toHaveBeenCalled();
    expect(store.customers).not.toHaveBeenCalled();
  });
});
