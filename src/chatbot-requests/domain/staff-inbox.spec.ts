import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { ChatbotRequestState } from './chatbot-request.commands';
import {
  CLOSED_WINDOW_DAYS,
  closedWindowCutoff,
  computeAllowedActions,
  decodeCursor,
  encodeCursor,
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
    expect(computeAllowedActions(question, CASHIER, ME)).toEqual([
      'CLAIM',
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
  it('round-trips parts, including null', () => {
    const raw = encodeCursor(['2026-11-10T00:00:00.000Z', null, 'abc']);
    expect(decodeCursor(raw, 3)).toEqual([
      '2026-11-10T00:00:00.000Z',
      null,
      'abc',
    ]);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['wrong arity', encodeCursor(['a'])],
    ['not an array', Buffer.from('{"a":1}').toString('base64url')],
    ['a number part', Buffer.from('[1,"b"]').toString('base64url')],
  ])('rejects %s with a validation error', (_name, raw) => {
    expect(() => decodeCursor(raw, 2)).toThrow(InvalidArgumentError);
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
