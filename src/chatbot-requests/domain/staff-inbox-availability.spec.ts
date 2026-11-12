/**
 * S8 (unit 4 additions): `allowedActions` and `deniedActions` come from ONE
 * evaluation of the state machine (`computeActionAvailability`).
 * `computeAllowedActions` keeps its contract: the differential block below
 * runs a verbatim copy of the pre-S8 implementation over a grid of states,
 * abilities and options and requires the same answer.
 */
import {
  cancelByStaff,
  canMergeSource,
  claim,
  heldByOther,
  linkCustomer,
  reassign,
  release,
  reply,
  resolve,
  type ChatbotRequestKind,
  type ChatbotRequestState,
  type ChatbotRequestSubtype,
  type ChatbotRequestStatus,
  type LiveSessionState,
} from './chatbot-request.commands';
import { canResolveSubtype } from './resolve-permissions';
import {
  computeActionAvailability,
  computeAllowedActions,
  type AllowedAction,
  type AllowedActionsOptions,
  type DeniedCode,
} from './staff-inbox';

type Grant = `${string}:${string}`;
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
const ME = 'user-me';
const heldBy = (userId: string) => ({ userId, displayName: 'Someone' });

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
const question = (over: Partial<ChatbotRequestState> = {}) =>
  state({ kind: 'CLARIFICATION', subtype: 'UNKNOWN_QUESTION', ...over });

const denied = (
  s: ChatbotRequestState,
  ability: { can(a: never, b: never): boolean },
  options: AllowedActionsOptions = {},
  userId = ME,
) =>
  computeActionAvailability(
    s,
    ability as Parameters<typeof computeActionAvailability>[1],
    userId,
    options,
  ).deniedActions;

describe('computeActionAvailability: deniedActions', () => {
  it('REQUEST_CLAIMED_BY_OTHER: claim, and resolve, of a request someone else holds', () => {
    const other = state({
      status: 'IN_PROGRESS',
      assignee: heldBy('user-ana'),
    });
    expect(denied(other, CASHIER)).toEqual(
      expect.arrayContaining([
        { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
      ]),
    );
    // Resolve needs the legacy permission first: a manager gets the state code.
    const managerView = denied(other, MANAGER);
    expect(managerView).toEqual([
      { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
      { action: 'RESOLVE', code: 'REQUEST_CLAIMED_BY_OTHER' },
      { action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' },
    ]);
  });

  it('NOT_ASSIGNEE: release and cancel of someone else’s request without the assignment permission', () => {
    const other = question({
      status: 'IN_PROGRESS',
      assignee: heldBy('user-ana'),
    });
    expect(denied(other, CASHIER)).toEqual([
      { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
      { action: 'RELEASE', code: 'NOT_ASSIGNEE' },
      { action: 'REASSIGN', code: 'INSUFFICIENT_PERMISSIONS' },
      // Unit 10: replying is the assignee's alone, for everyone.
      { action: 'REPLY', code: 'NOT_ASSIGNEE' },
      { action: 'CANCEL', code: 'NOT_ASSIGNEE' },
    ]);
    // A manager may release, reassign and cancel it: only claiming and
    // replying (the assignee's alone, unit 10) are denied.
    expect(denied(other, MANAGER)).toEqual([
      { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
      { action: 'REPLY', code: 'NOT_ASSIGNEE' },
    ]);
  });

  it('NOT_ASSIGNEE: merge of someone else’s request without the assignment permission (detail only)', () => {
    const other = question({
      status: 'IN_PROGRESS',
      assignee: heldBy('user-ana'),
    });
    expect(denied(other, CASHIER, { hasMergeCandidate: true })).toContainEqual({
      action: 'MERGE',
      code: 'NOT_ASSIGNEE',
    });
    expect(
      denied(other, MANAGER, { hasMergeCandidate: true }),
    ).not.toContainEqual(expect.objectContaining({ action: 'MERGE' }));
  });

  it('CANCEL_NOT_ALLOWED: a decision is resolved, never cancelled', () => {
    expect(denied(state(), MANAGER)).toEqual([
      { action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' },
    ]);
  });

  it('CANCEL_NOT_ALLOWED: a started live session pins the request (409)', () => {
    for (const live of ['STARTING', 'ACTIVE', 'ENDING'] as LiveSessionState[]) {
      expect(
        denied(
          state({
            kind: 'CONVERSATION',
            subtype: 'TALK_TO_HUMAN',
            status: 'IN_PROGRESS',
            assignee: heldBy(ME),
            liveSessionState: live,
          }),
          CASHIER,
        ),
      ).toContainEqual({ action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' });
    }
  });

  it('INSUFFICIENT_PERMISSIONS: a permission gate comes before any state answer, like the route guard', () => {
    // Cashier: no legacy permission to resolve a restock, no assignment to reassign.
    expect(
      denied(state({ status: 'IN_PROGRESS', assignee: heldBy(ME) }), CASHIER),
    ).toEqual([
      { action: 'REASSIGN', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'RESOLVE', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' },
    ]);
    // Read only: update is missing, so every applicable action is denied by permission.
    expect(denied(state(), READ_ONLY)).toEqual([
      { action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'RESOLVE', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'INSUFFICIENT_PERMISSIONS' },
    ]);
    // Even when someone else holds it, the permission is the first answer.
    expect(
      denied(
        state({ status: 'IN_PROGRESS', assignee: heldBy('user-ana') }),
        READ_ONLY,
      ),
    ).toContainEqual({ action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('LINK_CUSTOMER and MERGE are evaluated only when the detail passes their facts', () => {
    const open = question();
    const facts: AllowedActionsOptions = {
      hasMergeCandidate: true,
      hasLinkCandidate: true,
      customer: { customerId: null, customerKey: '525512345678' },
    };
    expect(denied(open, READ_ONLY, facts)).toEqual([
      { action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'REPLY', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'MERGE', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'LINK_CUSTOMER', code: 'INSUFFICIENT_PERMISSIONS' },
      { action: 'CANCEL', code: 'INSUFFICIENT_PERMISSIONS' },
    ]);
    // A row has no such facts: it can never list them as allowed or denied.
    const row = computeActionAvailability(open, READ_ONLY, ME);
    expect(row.deniedActions.map((d) => d.action)).toEqual([
      'CLAIM',
      'REPLY',
      'CANCEL',
    ]);
    const rowManager = computeActionAvailability(open, MANAGER, ME);
    expect(rowManager.allowedActions).not.toContain('MERGE');
    expect(rowManager.allowedActions).not.toContain('LINK_CUSTOMER');
  });

  it('leaves out actions that do not apply to the state (no noise), and never lists a closed row', () => {
    // NEW: release and reassign do not apply to anyone.
    const actions = denied(question(), READ_ONLY).map((d) => d.action);
    expect(actions).not.toContain('RELEASE');
    expect(actions).not.toContain('REASSIGN');
    // A clarification never resolves; DISCOUNT has no wrapped resolve route.
    expect(actions).not.toContain('RESOLVE');
    expect(
      denied(state({ subtype: 'DISCOUNT' }), READ_ONLY).map((d) => d.action),
    ).not.toContain('RESOLVE');
    // Own request: claiming it again is a stale view, not a denial.
    expect(
      denied(state({ status: 'IN_PROGRESS', assignee: heldBy(ME) }), MANAGER),
    ).toEqual([{ action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' }]);
    // Closed: no command applies.
    for (const status of ['RESOLVED', 'CANCELLED'] as const) {
      const closed = computeActionAvailability(
        state({ status }),
        READ_ONLY,
        ME,
      );
      expect(closed).toEqual({ allowedActions: [], deniedActions: [] });
    }
    // A zone request without a validation: resolve answers 404, not a denial.
    expect(
      denied(state({ subtype: 'DELIVERY_ZONE' }), READ_ONLY, {
        resolveTargetMissing: true,
      }).map((d) => d.action),
    ).not.toContain('RESOLVE');
  });

  it('an action is never both allowed and denied, appears at most once, and carries only a code', () => {
    const open = question();
    const { allowedActions, deniedActions } = computeActionAvailability(
      open,
      CASHIER,
      ME,
    );
    const names = [...allowedActions, ...deniedActions.map((d) => d.action)];
    expect(new Set(names).size).toBe(names.length);
    for (const entry of deniedActions) {
      expect(Object.keys(entry).sort()).toEqual(['action', 'code']);
    }
  });
});

// ---------------------------------------------------------------- differential

/** Verbatim copy of `computeAllowedActions` before S8 (the oracle). */
function legacyAllowedActions(
  s: ChatbotRequestState,
  ability: { can(a: never, b: never): boolean },
  userId: string,
  options: AllowedActionsOptions = {},
): AllowedAction[] {
  const can = (a: string, b: string) =>
    (ability as { can(a: string, b: string): boolean }).can(a, b);
  const actor = { userId, displayName: '-' };
  const now = new Date();
  const expectedVersion = s.version;
  const canUpdate = can('update', 'ChatbotRequest');
  const canReassign = can('update', 'ChatbotRequestAssignment');
  const permission = {
    can: (a: string, b: string) => can(a, b),
  } as Parameters<typeof canResolveSubtype>[0];
  const offered: Array<[AllowedAction, boolean]> = [
    ['CLAIM', canUpdate && claim(s, { actor, expectedVersion, now }).ok],
    [
      'RELEASE',
      canUpdate &&
        release(s, { actor, expectedVersion, actorCanReassign: canReassign })
          .ok,
    ],
    [
      'REASSIGN',
      canReassign &&
        reassign(s, {
          actor,
          expectedVersion,
          toUser: { userId: `${userId}:candidate`, displayName: '-' },
          now,
        }).ok,
    ],
    [
      'RESOLVE',
      canUpdate &&
        !options.resolveTargetMissing &&
        canResolveSubtype(permission, s.subtype) &&
        resolve(s, { actor, expectedVersion, action: 'RESOLVE', now }).ok,
    ],
    [
      'REPLY',
      canUpdate &&
        reply(s, {
          actor,
          expectedVersion,
          replyId: 'candidate',
          text: 'candidate',
          now,
        }).ok,
    ],
    [
      'MERGE',
      canUpdate &&
        options.hasMergeCandidate === true &&
        canMergeSource(s) &&
        !(heldByOther(s, actor) && !canReassign),
    ],
    [
      'LINK_CUSTOMER',
      canUpdate &&
        options.customer !== undefined &&
        options.hasLinkCandidate === true &&
        linkCustomer(s, {
          actor,
          expectedVersion,
          customerId: 'candidate',
          current: options.customer,
        }).ok,
    ],
    [
      'CANCEL',
      canUpdate &&
        cancelByStaff(s, {
          actor,
          actorCanReassign: canReassign,
          expectedVersion,
          reason: 'DUPLICATE',
          now,
        }).ok,
    ],
  ];
  return offered.filter(([, ok]) => ok).map(([action]) => action);
}

describe('computeAllowedActions is unchanged (differential vs the pre-S8 rules, plus unit 10 REPLY)', () => {
  const kinds: Array<[ChatbotRequestKind, ChatbotRequestSubtype]> = [
    ['DECISION', 'RESTOCK'],
    ['DECISION', 'EXPIRATION'],
    ['DECISION', 'DELIVERY_ZONE'],
    ['DECISION', 'TRANSFER_RECEIPT'],
    ['DECISION', 'DISCOUNT'],
    ['CLARIFICATION', 'UNKNOWN_QUESTION'],
    ['CONVERSATION', 'TALK_TO_HUMAN'],
    ['CONVERSATION', 'COMPLAINT'],
  ];
  const statuses: ChatbotRequestStatus[] = [
    'NEW',
    'IN_PROGRESS',
    'RESOLVED',
    'CANCELLED',
  ];
  const sessions: Array<LiveSessionState | null> = [
    null,
    'WAITING',
    'ACTIVE',
    'ENDED',
  ];
  const holders: Array<ChatbotRequestState['assignee']> = [
    null,
    heldBy(ME),
    heldBy('user-ana'),
  ];
  const abilities = {
    MANAGER,
    CASHIER,
    READ_ONLY,
    ASSIGNER_ONLY: abilityOf(
      'read:ChatbotRequest',
      'update:ChatbotRequestAssignment',
    ),
    ZONE_ONLY: abilityOf(
      'read:ChatbotRequest',
      'update:ChatbotRequest',
      'validate:DeliveryZone',
    ),
  };
  const optionSets: AllowedActionsOptions[] = [
    {},
    { resolveTargetMissing: true },
    { hasMergeCandidate: true },
    {
      hasMergeCandidate: true,
      hasLinkCandidate: true,
      customer: { customerId: null, customerKey: '525512345678' },
    },
    {
      hasLinkCandidate: true,
      customer: { customerId: 'c-1', customerKey: '525512345678' },
    },
    {
      hasLinkCandidate: true,
      customer: { customerId: null, customerKey: 'unknown:abc' },
    },
  ];

  it('gives the same list for every combination, and allowed/denied never overlap', () => {
    let combinations = 0;
    for (const [kind, subtype] of kinds) {
      for (const status of statuses) {
        for (const live of sessions) {
          for (const assignee of holders) {
            for (const [name, ability] of Object.entries(abilities)) {
              for (const options of optionSets) {
                const s = state({
                  kind,
                  subtype,
                  status,
                  assignee,
                  liveSessionState: live,
                });
                const label = JSON.stringify({
                  kind,
                  subtype,
                  status,
                  live,
                  assignee: assignee?.userId,
                  name,
                  options,
                });
                const expected = legacyAllowedActions(s, ability, ME, options);
                expect({
                  label,
                  got: computeAllowedActions(s, ability, ME, options),
                }).toEqual({
                  label,
                  got: expected,
                });
                const both = computeActionAvailability(s, ability, ME, options);
                expect(both.allowedActions).toEqual(expected);
                const deniedNames = both.deniedActions.map((d) => d.action);
                for (const action of expected) {
                  expect(deniedNames).not.toContain(action);
                }
                const codes: DeniedCode[] = [
                  'INSUFFICIENT_PERMISSIONS',
                  'REQUEST_CLAIMED_BY_OTHER',
                  'NOT_ASSIGNEE',
                  'CANCEL_NOT_ALLOWED',
                ];
                for (const entry of both.deniedActions) {
                  expect(codes).toContain(entry.code);
                }
                combinations += 1;
              }
            }
          }
        }
      }
    }
    expect(combinations).toBeGreaterThan(5000);
  });
});
