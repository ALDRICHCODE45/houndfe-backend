import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { ChatbotRequestState } from './chatbot-request.commands';
import {
  CLOSED_WINDOW_DAYS,
  closedWindowCutoff,
  computeAllowedActions,
  decodeCursor,
  encodeCursor,
  isSaneDate,
} from './staff-inbox';

type Grant = `${string}:${string}`;
const abilityOf = (...grants: Grant[]) => ({
  can: (action: string, subject: string) =>
    grants.includes(`${action}:${subject}`),
});

const CASHIER = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
  'read:ChatbotConversation',
);
const MANAGER = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
  'update:ChatbotRequestAssignment',
  'update:HumanDecision',
  'validate:DeliveryZone',
  'update:ReceiptEvidence',
);
const READ_ONLY = abilityOf('read:ChatbotRequest');
const UPDATE_WITHOUT_LEGACY = abilityOf(
  'read:ChatbotRequest',
  'update:ChatbotRequest',
);

const ME = 'user-me';
const state = (
  over: Partial<ChatbotRequestState> = {},
): ChatbotRequestState => ({
  kind: 'DECISION',
  subtype: 'RESTOCK',
  status: 'NEW',
  version: 3,
  assignee: null,
  overdueAt: null,
  liveSessionState: null,
  ...over,
});
const heldBy = (userId: string) => ({ userId, displayName: 'Someone' });

describe('computeAllowedActions', () => {
  it('offers claim and resolve on a NEW decision to a manager', () => {
    expect(computeAllowedActions(state(), MANAGER, ME)).toEqual([
      'CLAIM',
      'RESOLVE',
    ]);
  });

  it('never offers resolve to a cashier or to update without the legacy permission', () => {
    expect(computeAllowedActions(state(), CASHIER, ME)).toEqual(['CLAIM']);
    expect(computeAllowedActions(state(), UPDATE_WITHOUT_LEGACY, ME)).toEqual([
      'CLAIM',
    ]);
  });

  it('checks the legacy permission of the subtype', () => {
    const zone = state({ subtype: 'DELIVERY_ZONE' });
    expect(
      computeAllowedActions(
        zone,
        abilityOf('update:ChatbotRequest', 'update:HumanDecision'),
        ME,
      ),
    ).toEqual(['CLAIM']);
    expect(
      computeAllowedActions(
        zone,
        abilityOf('update:ChatbotRequest', 'validate:DeliveryZone'),
        ME,
      ),
    ).toEqual(['CLAIM', 'RESOLVE']);
  });

  it('offers release, resolve and no claim on my own request', () => {
    const mine = state({ status: 'IN_PROGRESS', assignee: heldBy(ME) });
    expect(computeAllowedActions(mine, MANAGER, ME)).toEqual([
      'RELEASE',
      'REASSIGN',
      'RESOLVE',
    ]);
  });

  it('on a request held by someone else: reassigners may release and reassign, others see nothing', () => {
    const other = state({
      status: 'IN_PROGRESS',
      assignee: heldBy('user-ana'),
    });
    expect(computeAllowedActions(other, MANAGER, ME)).toEqual([
      'RELEASE',
      'REASSIGN',
    ]);
    expect(computeAllowedActions(other, CASHIER, ME)).toEqual([]);
  });

  it('offers cancel on a clarification, not on a decision', () => {
    const question = state({
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
    });
    // Unit 10 / S13: a NEW clarification can be answered (replying claims it).
    expect(computeAllowedActions(question, CASHIER, ME)).toEqual([
      'CLAIM',
      'REPLY',
      'CANCEL',
    ]);
    expect(computeAllowedActions(state(), CASHIER, ME)).not.toContain('CANCEL');
  });

  it('offers nothing on a closed request or to a read-only user', () => {
    expect(
      computeAllowedActions(state({ status: 'RESOLVED' }), MANAGER, ME),
    ).toEqual([]);
    expect(
      computeAllowedActions(state({ status: 'CANCELLED' }), MANAGER, ME),
    ).toEqual([]);
    expect(computeAllowedActions(state(), READ_ONLY, ME)).toEqual([]);
  });

  it('does not offer RESOLVE on a zone request that has no validation (the route answers 404)', () => {
    const zone = state({ subtype: 'DELIVERY_ZONE' });
    const ability = abilityOf('update:ChatbotRequest', 'validate:DeliveryZone');
    expect(computeAllowedActions(zone, ability, ME)).toEqual([
      'CLAIM',
      'RESOLVE',
    ]);
    expect(
      computeAllowedActions(zone, ability, ME, { resolveTargetMissing: true }),
    ).toEqual(['CLAIM']);
  });

  it('never offers reschedule (scheduling arrives with unit 14)', () => {
    const conversation = state({
      kind: 'CONVERSATION',
      subtype: 'TALK_TO_HUMAN',
    });
    expect(computeAllowedActions(conversation, MANAGER, ME)).not.toContain(
      'RESCHEDULE',
    );
  });
});

describe('cursors', () => {
  const DATE = '2026-11-10T00:00:00.000Z';
  const UUID = '2b7c1a90-6f3e-4d2a-8b1c-0d9e8f7a6b5c';

  it('round-trips parts of every kind, including a null date', () => {
    const raw = encodeCursor([DATE, null, UUID, 'k1.token']);
    expect(decodeCursor(raw, ['date', 'date?', 'uuid', 'text'])).toEqual([
      DATE,
      null,
      UUID,
      'k1.token',
    ]);
  });

  it.each([
    ['not base64 json', '%%%', ['text', 'text']],
    ['wrong arity', encodeCursor(['a']), ['text', 'text']],
    [
      'not an array',
      Buffer.from('{"a":1}').toString('base64url'),
      ['text', 'text'],
    ],
    [
      'a number part',
      Buffer.from('[1,"b"]').toString('base64url'),
      ['text', 'text'],
    ],
    [
      'a date that does not parse',
      encodeCursor(['not-a-date', 'x']),
      ['date', 'text'],
    ],
    [
      'a date that is not a real day',
      encodeCursor(['2026-13-45T00:00:00.000Z', 'x']),
      ['date', 'text'],
    ],
    [
      'a date PostgreSQL cannot store (year 0)',
      encodeCursor(['0000-01-01T00:00:00.000Z', 'x']),
      ['date', 'text'],
    ],
    [
      'a date without the ISO form',
      encodeCursor(['2026-11-10', 'x']),
      ['date', 'text'],
    ],
    [
      'a null where a date is required',
      encodeCursor([null, 'x']),
      ['date', 'text'],
    ],
    [
      'an id that is not a UUID',
      encodeCursor([DATE, 'nope']),
      ['date', 'uuid'],
    ],
    ['an empty text part', encodeCursor([DATE, '']), ['date', 'text']],
  ] as const)('rejects %s with a validation error', (_name, raw, kinds) => {
    expect(() => decodeCursor(raw, [...kinds])).toThrow(InvalidArgumentError);
  });
});

describe('isSaneDate', () => {
  it('accepts dates PostgreSQL can store and rejects the rest', () => {
    expect(isSaneDate(new Date('2026-11-10T00:00:00.000Z'))).toBe(true);
    expect(isSaneDate(new Date('not-a-date'))).toBe(false);
    expect(isSaneDate(new Date('0001-01-01T00:00:00.000Z'))).toBe(false);
    expect(isSaneDate(new Date('+275000-01-01T00:00:00.000Z'))).toBe(false);
  });
});

describe('closedWindowCutoff', () => {
  it('is exactly seven days before now', () => {
    expect(CLOSED_WINDOW_DAYS).toBe(7);
    const now = new Date('2026-11-11T12:00:00.000Z');
    expect(closedWindowCutoff(now).toISOString()).toBe(
      '2026-11-04T12:00:00.000Z',
    );
  });
});

describe('computeAllowedActions: MERGE and LINK_CUSTOMER', () => {
  const question = state({
    kind: 'CLARIFICATION',
    subtype: 'UNKNOWN_QUESTION',
  });
  const unlinked = { customerId: null, customerKey: '525512345678' };
  const withCandidate = { hasMergeCandidate: true };

  it('offers MERGE only with update, a mergeable open request and a candidate', () => {
    expect(computeAllowedActions(question, CASHIER, ME, withCandidate)).toEqual(
      ['CLAIM', 'REPLY', 'MERGE', 'CANCEL'],
    );
    expect(computeAllowedActions(question, CASHIER, ME)).not.toContain('MERGE');
    expect(
      computeAllowedActions(question, READ_ONLY, ME, withCandidate),
    ).toEqual([]);
    // wrapped decisions never merge, even when the store reports a candidate
    expect(
      computeAllowedActions(state(), MANAGER, ME, withCandidate),
    ).not.toContain('MERGE');
    expect(
      computeAllowedActions(
        state({ ...question, status: 'RESOLVED' }),
        MANAGER,
        ME,
        withCandidate,
      ),
    ).toEqual([]);
  });

  it('on a request held by someone else, MERGE follows the cancel rule: only with the assignment permission', () => {
    const other = state({
      ...question,
      status: 'IN_PROGRESS',
      assignee: heldBy('user-ana'),
    });
    expect(computeAllowedActions(other, CASHIER, ME, withCandidate)).toEqual(
      [],
    );
    expect(computeAllowedActions(other, MANAGER, ME, withCandidate)).toEqual([
      'RELEASE',
      'REASSIGN',
      'MERGE',
      'CANCEL',
    ]);
    const mine = state({
      ...question,
      status: 'IN_PROGRESS',
      assignee: heldBy(ME),
    });
    expect(computeAllowedActions(mine, CASHIER, ME, withCandidate)).toContain(
      'MERGE',
    );
  });

  it('offers LINK_CUSTOMER for an open request with a phone key, no customer and a candidate', () => {
    const link = { customer: unlinked, hasLinkCandidate: true };
    expect(computeAllowedActions(question, CASHIER, ME, link)).toEqual([
      'CLAIM',
      'REPLY',
      'LINK_CUSTOMER',
      'CANCEL',
    ]);
    expect(computeAllowedActions(question, READ_ONLY, ME, link)).toEqual([]);
  });

  it('does not offer LINK_CUSTOMER without a candidate customer', () => {
    expect(
      computeAllowedActions(question, CASHIER, ME, { customer: unlinked }),
    ).not.toContain('LINK_CUSTOMER');
    expect(
      computeAllowedActions(question, CASHIER, ME, {
        customer: unlinked,
        hasLinkCandidate: false,
      }),
    ).not.toContain('LINK_CUSTOMER');
  });

  it('hides LINK_CUSTOMER when linked, for an unknown: key and when closed', () => {
    const none = (customer: {
      customerId: string | null;
      customerKey: string;
    }) =>
      computeAllowedActions(question, CASHIER, ME, {
        customer,
        hasLinkCandidate: true,
      });
    expect(none({ ...unlinked, customerId: 'c-1' })).not.toContain(
      'LINK_CUSTOMER',
    );
    expect(none({ ...unlinked, customerKey: 'unknown:abc' })).not.toContain(
      'LINK_CUSTOMER',
    );
    expect(
      computeAllowedActions(
        state({ ...question, status: 'CANCELLED' }),
        MANAGER,
        ME,
        { customer: unlinked, hasLinkCandidate: true },
      ),
    ).toEqual([]);
  });
});
