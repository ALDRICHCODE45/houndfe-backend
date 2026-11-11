import {
  ChatbotRequestCommandError,
  type ChatbotRequestCommandStore,
  type ChatbotRequestRow,
} from './chatbot-request-commands.service';
import {
  ChatbotRequestRelationsService,
  type ChatbotRequestRelationStore,
  type LinkRow,
} from './chatbot-request-relations.service';

const ANA = { userId: 'u-ana', displayName: 'Ana' };
const KEY = '525512345678';
const IDEM = '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f';

const row = (id: string, over: Partial<LinkRow> = {}): LinkRow => ({
  id,
  folio: id === 'a' ? 10 : 11,
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  version: 2,
  customerKey: KEY,
  customerId: null,
  assigneeUserId: null,
  assigneeDisplayName: null,
  claimedAt: null,
  overdueAt: null,
  closedAt: null,
  humanDecisionId: null,
  deliveryZoneRequestId: null,
  receiptEvidenceId: null,
  ...over,
});

/** Records every port call in order, over an in-memory set of rows. */
function fakes(
  rows: LinkRow[],
  customer: { phoneCountryCode: string | null; phone: string | null } | null = {
    phoneCountryCode: '52',
    phone: '5512345678',
  },
) {
  const calls: string[] = [];
  const receipts = new Map<
    string,
    { commandHash: string; responseSnapshot: unknown }
  >();
  const commands = {
    transaction: async <T>(work: () => Promise<T>) => {
      calls.push('begin');
      const out = await work();
      calls.push('commit');
      return out;
    },
    lockIdempotencyKey: () => {
      calls.push('lockKey');
      return Promise.resolve();
    },
    findReceipt: (actor: string, key: string) =>
      Promise.resolve(receipts.get(`${actor}:${key}`) ?? null),
    saveReceipt: (
      actor: string,
      key: string,
      commandHash: string,
      responseSnapshot: unknown,
    ) => {
      calls.push('saveReceipt');
      receipts.set(`${actor}:${key}`, { commandHash, responseSnapshot });
      return Promise.resolve();
    },
    findActor: (id: string) => Promise.resolve(id === ANA.userId ? ANA : null),
    applyPatch: (r: ChatbotRequestRow, patch: { version: number }) => {
      calls.push(`applyPatch:${r.id}:v${patch.version}`);
      return Promise.resolve();
    },
    refreshGroups: (keys: string[]) => {
      calls.push(`refreshGroups:${keys.join(',')}`);
      return Promise.resolve();
    },
  } as unknown as ChatbotRequestCommandStore;
  const relations: ChatbotRequestRelationStore = {
    peekRequests: (ids) => {
      calls.push('peek');
      return Promise.resolve(rows.filter((r) => ids.includes(r.id)));
    },
    lockRequests: (ids) => {
      calls.push(`lockRequests:${[...ids].sort().join(',')}`);
      return Promise.resolve(
        rows
          .filter((r) => ids.includes(r.id))
          .sort((x, y) => x.id.localeCompare(y.id)),
      );
    },
    recordEvent: (id, event) => {
      calls.push(`recordEvent:${id}:${event.type}:v${event.version}`);
      return Promise.resolve();
    },
    lockZonesOfKey: () => {
      calls.push('lockZonesOfKey');
      return Promise.resolve();
    },
    lockLinkSet: () => {
      calls.push('lockLinkSet');
      return Promise.resolve(
        rows.filter((r) => r.customerId === null || r.id === 'a'),
      );
    },
    findCustomer: () => {
      calls.push('findCustomer');
      return Promise.resolve(customer && { id: 'cus-1', ...customer });
    },
    linkSiblings: (siblings) => {
      calls.push(`linkSiblings:${siblings.map((s) => s.id).join(',')}`);
      return Promise.resolve();
    },
  };
  return {
    service: new ChatbotRequestRelationsService(commands, relations),
    calls,
  };
}

const mergeInput = (over = {}) => ({
  requestId: 'a',
  intoRequestId: 'b',
  actorUserId: ANA.userId,
  idempotencyKey: IDEM,
  expectedVersion: 2,
  intoExpectedVersion: 2,
  ...over,
});
const linkInput = (over = {}) => ({
  requestId: 'a',
  customerId: 'cus-1',
  actorUserId: ANA.userId,
  idempotencyKey: IDEM,
  expectedVersion: 2,
  ...over,
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotRequestCommandError) return error;
    throw error;
  }
  throw new Error('expected a ChatbotRequestCommandError');
}

describe('ChatbotRequestRelationsService.merge', () => {
  it('locks both rows in one id-ordered statement, closes the source, audits both, then the group', async () => {
    const { service, calls } = fakes([row('a'), row('b')]);
    const view = await service.merge(mergeInput());

    expect(calls).toEqual([
      'begin',
      'lockKey',
      'peek',
      'lockRequests:a,b',
      'applyPatch:a:v3',
      'recordEvent:b:MERGED:v2',
      'refreshGroups:' + KEY,
      'saveReceipt',
      'commit',
    ]);
    expect(view).toMatchObject({ id: 'a', status: 'CANCELLED', version: 3 });
  });

  it('merging B into A locks the same pair in the same order (no crossing)', async () => {
    const { service, calls } = fakes([row('a'), row('b')]);
    await service.merge(mergeInput({ requestId: 'b', intoRequestId: 'a' }));
    expect(calls).toContain('lockRequests:a,b');
  });

  it('refuses a wrapped subtype BEFORE taking any request lock', async () => {
    const { service, calls } = fakes([
      row('a', {
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE',
        deliveryZoneRequestId: 'z-1',
      }),
      row('b', {
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE',
        deliveryZoneRequestId: 'z-2',
      }),
    ]);
    const error = await failure(service.merge(mergeInput()));
    expect(error).toMatchObject({ code: 'MERGE_NOT_ALLOWED', httpStatus: 422 });
    expect(calls.some((c) => c.startsWith('lockRequests'))).toBe(false);
    expect(calls).not.toContain('saveReceipt');
  });

  it('404s when either id is missing', async () => {
    const { service } = fakes([row('a')]);
    expect(await failure(service.merge(mergeInput()))).toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('answers a target failure with the target current and intoRequestId', async () => {
    const { service } = fakes([row('a'), row('b', { version: 5 })]);
    const error = await failure(service.merge(mergeInput()));
    expect(error).toMatchObject({
      code: 'VERSION_CONFLICT',
      httpStatus: 409,
      current: { version: 5 },
      extra: { intoRequestId: 'b' },
    });
  });

  it('answers a source failure without intoRequestId', async () => {
    const { service } = fakes([row('a', { version: 9 }), row('b')]);
    const error = await failure(service.merge(mergeInput()));
    expect(error).toMatchObject({
      code: 'VERSION_CONFLICT',
      current: { version: 9 },
    });
    expect(error.extra).toBeUndefined();
  });

  it('refuses a request merged into itself', async () => {
    const { service } = fakes([row('a')]);
    const error = await failure(
      service.merge(mergeInput({ intoRequestId: 'a' })),
    );
    expect(error.code).toBe('MERGE_NOT_ALLOWED');
  });

  it('replays the stored response and conflicts on another body', async () => {
    const { service, calls } = fakes([row('a'), row('b')]);
    const first = await service.merge(mergeInput());
    calls.length = 0;
    await expect(service.merge(mergeInput())).resolves.toEqual(first);
    expect(calls).not.toContain('peek');
    const error = await failure(
      service.merge(mergeInput({ intoExpectedVersion: 3 })),
    );
    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    });
  });

  it('a merge key cannot be replayed as a link-customer', async () => {
    const { service } = fakes([row('a'), row('b')]);
    await service.merge(mergeInput());
    const error = await failure(service.linkCustomer(linkInput()));
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('ChatbotRequestRelationsService.linkCustomer', () => {
  it('takes the zone locks first, then the key rows, then writes anchor and siblings', async () => {
    const { service, calls } = fakes([
      row('a'),
      row('b'),
      row('c', { customerId: 'cus-9' }),
    ]);
    const view = await service.linkCustomer(linkInput());

    expect(calls).toEqual([
      'begin',
      'lockKey',
      'peek',
      'lockZonesOfKey',
      'lockLinkSet',
      'findCustomer',
      'applyPatch:a:v3',
      'linkSiblings:b',
      'saveReceipt',
      'commit',
    ]);
    expect(view).toMatchObject({ id: 'a', version: 3 });
    // the key never changes: no group is touched
    expect(calls.some((c) => c.startsWith('refreshGroups'))).toBe(false);
  });

  it('refuses a customer whose phone is not the request key (422), writing nothing', async () => {
    const { service, calls } = fakes([row('a')], {
      phoneCountryCode: '52',
      phone: '5599999999',
    });
    const error = await failure(service.linkCustomer(linkInput()));
    expect(error).toMatchObject({
      code: 'CUSTOMER_PHONE_MISMATCH',
      httpStatus: 422,
      current: { version: 2 },
    });
    expect(calls.some((c) => c.startsWith('applyPatch'))).toBe(false);
  });

  it('accepts the 521 mobile form of the same number', async () => {
    const { service } = fakes([row('a')], {
      phoneCountryCode: '521',
      phone: '5512345678',
    });
    await expect(service.linkCustomer(linkInput())).resolves.toMatchObject({
      id: 'a',
    });
  });

  it('404s for a customer of another tenant (not found in this one) and for a missing request', async () => {
    const { service } = fakes([row('a')], null);
    expect(await failure(service.linkCustomer(linkInput()))).toMatchObject({
      code: 'NOT_FOUND',
    });
    const { service: empty } = fakes([]);
    expect(await failure(empty.linkCustomer(linkInput()))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('answers the state errors before it looks at the customer', async () => {
    const stale = fakes([row('a', { version: 7 })]);
    expect(
      await failure(stale.service.linkCustomer(linkInput())),
    ).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(stale.calls).not.toContain('findCustomer');
    const linked = fakes([row('a', { customerId: 'cus-9' })]);
    expect(
      await failure(linked.service.linkCustomer(linkInput())),
    ).toMatchObject({ code: 'ACTION_NOT_ALLOWED', httpStatus: 422 });
    const unknown = fakes([row('a', { customerKey: 'unknown:abc' })]);
    expect(
      await failure(unknown.service.linkCustomer(linkInput())),
    ).toMatchObject({ code: 'ACTION_NOT_ALLOWED' });
    expect(unknown.calls).not.toContain('lockZonesOfKey');
  });
});
