/**
 * Unit 10: `REPLY` in `allowedActions` / `deniedActions` (contract §3.8, S8).
 * The offer replays the real `reply` command, so the code of a denied REPLY is
 * the code the command answers (`NOT_ASSIGNEE`), and permission gates come
 * first (`INSUFFICIENT_PERMISSIONS`), like every other action.
 */
import type {
  ChatbotRequestState,
  StaffActor,
} from './chatbot-request.commands';
import {
  computeActionAvailability,
  type ActionAvailability,
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
);
const READ_ONLY = abilityOf('read:ChatbotRequest');
const ME = 'user-me';
const someone = (userId: string): StaffActor => ({
  userId,
  displayName: 'Someone',
});

const question = (
  over: Partial<ChatbotRequestState> = {},
): ChatbotRequestState => ({
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  version: 3,
  assignee: null,
  overdueAt: null,
  liveSessionState: null,
  ...over,
});
const mine = (over: Partial<ChatbotRequestState> = {}) =>
  question({ status: 'IN_PROGRESS', assignee: someone(ME), ...over });

const availability = (
  state: ChatbotRequestState,
  ability: { can(a: never, b: never): boolean },
): ActionAvailability =>
  computeActionAvailability(
    state,
    ability as Parameters<typeof computeActionAvailability>[1],
    ME,
  );

describe('REPLY in allowedActions / deniedActions (unit 10)', () => {
  it('is offered to the assignee of an open clarification, right after RESOLVE’s slot and before CANCEL', () => {
    expect(availability(mine(), CASHIER).allowedActions).toEqual([
      'RELEASE',
      'REPLY',
      'CANCEL',
    ]);
    expect(availability(mine(), MANAGER).allowedActions).toEqual([
      'RELEASE',
      'REASSIGN',
      'REPLY',
      'CANCEL',
    ]);
  });

  it('is allowed on a NEW clarification: replying claims it implicitly (S13)', () => {
    const view = availability(question(), CASHIER);
    expect(view.allowedActions).toEqual(['CLAIM', 'REPLY', 'CANCEL']);
    expect(view.deniedActions.map((d) => d.action)).not.toContain('REPLY');
  });

  it('is denied NOT_ASSIGNEE on someone else’s request, even for a manager with the assignment permission', () => {
    const theirs = mine({ assignee: someone('user-other') });
    for (const ability of [CASHIER, MANAGER]) {
      const view = availability(theirs, ability);
      expect(view.allowedActions).not.toContain('REPLY');
      expect(view.deniedActions).toContainEqual({
        action: 'REPLY',
        code: 'NOT_ASSIGNEE',
      });
    }
  });

  it('is denied INSUFFICIENT_PERMISSIONS without update:ChatbotRequest (gates come first)', () => {
    const view = availability(mine(), READ_ONLY);
    expect(view.allowedActions).toEqual([]);
    expect(view.deniedActions).toContainEqual({
      action: 'REPLY',
      code: 'INSUFFICIENT_PERMISSIONS',
    });
  });

  it.each([
    ['a decision', question({ kind: 'DECISION', subtype: 'RESTOCK' })],
    [
      'a conversation',
      question({ kind: 'CONVERSATION', subtype: 'TALK_TO_HUMAN' }),
    ],
    ['a resolved clarification', mine({ status: 'RESOLVED' })],
    ['a cancelled clarification', mine({ status: 'CANCELLED' })],
  ])('does not apply to %s: in neither list', (_name, state) => {
    const view = availability(state, MANAGER);
    expect(view.allowedActions).not.toContain('REPLY');
    expect(view.deniedActions.map((d) => d.action)).not.toContain('REPLY');
  });
});
