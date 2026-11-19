/**
 * Unit 12 (§4.8): `complaintOutcome` is mandatory to finish a COMPLAINT, but
 * that is a field of the body, not a reason to hide the button: FINISH stays
 * offered for a live COMPLAINT exactly as it is for any other conversation
 * (the offer replays `finish` with a candidate outcome).
 */
import type { ChatbotRequestState } from './chatbot-request.commands';
import { computeActionAvailability } from './staff-inbox';

const ME = 'user-me';
const CASHIER = {
  can: (action: string, subject: string) =>
    ['read:ChatbotRequest', 'update:ChatbotRequest'].includes(
      `${action}:${subject}`,
    ),
};
const live = (subtype: 'COMPLAINT' | 'TALK_TO_HUMAN'): ChatbotRequestState => ({
  kind: 'CONVERSATION',
  subtype,
  status: 'IN_PROGRESS',
  version: 4,
  assignee: { userId: ME, displayName: 'Me' },
  overdueAt: null,
  liveSessionState: 'ACTIVE',
});
const availability = (state: ChatbotRequestState) =>
  computeActionAvailability(
    state,
    CASHIER as Parameters<typeof computeActionAvailability>[1],
    ME,
  );

describe('FINISH of a COMPLAINT in allowedActions (unit 12)', () => {
  it('is offered to the assignee of an ACTIVE COMPLAINT, like any conversation', () => {
    expect(availability(live('COMPLAINT')).allowedActions).toContain('FINISH');
    expect(availability(live('COMPLAINT'))).toEqual(
      availability(live('TALK_TO_HUMAN')),
    );
  });
});
