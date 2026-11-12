import {
  buildConversationEndedPayload,
  buildConversationStartedPayload,
  buildStaffMessagePayload,
  buildTemplateRequestedPayload,
  classifyOutcome,
  FEED_TYPE,
  hashFeedOutcome,
  type FeedOutcomeInput,
} from './chatbot-feed';

const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const AT = '2026-11-13T16:20:00.000Z';
const pending = (type: string) => ({
  type,
  attemptId: null,
  evidenceHash: null,
  ackedAt: null,
});
const decide = (type: string, outcome: FeedOutcomeInput['outcome']) => {
  const input: FeedOutcomeInput = {
    attemptId: ATTEMPT,
    outcome,
    attemptedAt: AT,
    ...(outcome === 'PROVIDER_ACCEPTED'
      ? { providerMessageId: 'wamid.1' }
      : {}),
  };
  return classifyOutcome(pending(type), input, hashFeedOutcome(input));
};

describe('live conversation feed types (unit 11)', () => {
  it('names the four item types of the contract', () => {
    expect(FEED_TYPE.conversationStarted).toBe('conversation.started');
    expect(FEED_TYPE.staffMessage).toBe('conversation.staff_message');
    expect(FEED_TYPE.templateRequested).toBe('template.requested');
    expect(FEED_TYPE.conversationEnded).toBe('conversation.ended');
  });

  it('builds the payloads exactly as the bot contract lists them', () => {
    expect(
      buildConversationStartedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        staffFirstName: 'Ana',
        whatsappWindowClosesAt: new Date(AT),
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      staffFirstName: 'Ana',
      whatsappWindowClosesAt: AT,
    });
    expect(
      buildConversationStartedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        staffFirstName: null,
        whatsappWindowClosesAt: null,
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      staffFirstName: null,
      whatsappWindowClosesAt: null,
    });
    expect(
      buildStaffMessagePayload({
        requestId: 'r',
        handoffEpoch: 3,
        seq: 17,
        messageId: 'm',
        text: 'Hola',
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      seq: 17,
      messageId: 'm',
      type: 'TEXT',
      text: 'Hola',
    });
    expect(
      buildTemplateRequestedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        seq: 18,
        messageId: 'm2',
        templateName: 'reabrir',
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      seq: 18,
      messageId: 'm2',
      templateName: 'reabrir',
    });
  });

  it('farewell is false only for the start revert', () => {
    const ended = (
      reason: Parameters<typeof buildConversationEndedPayload>[0]['reason'],
    ) =>
      buildConversationEndedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        reason,
      });
    expect(ended('FINISHED').farewell).toBe(true);
    expect(ended('FORCED').farewell).toBe(true);
    expect(ended('IDLE_TIMEOUT').farewell).toBe(true);
    expect(ended('START_TIMEOUT')).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      reason: 'START_TIMEOUT',
      farewell: false,
    });
  });

  describe('which outcomes each type accepts (bot contract table)', () => {
    it.each([
      [FEED_TYPE.conversationStarted, 'PROVIDER_ACCEPTED', 'APPLY'],
      [FEED_TYPE.conversationStarted, 'DELIVERY_UNKNOWN', 'APPLY'],
      [FEED_TYPE.conversationStarted, 'STALE', 'APPLY'],
      [
        FEED_TYPE.conversationStarted,
        'DEFERRED_WINDOW_CLOSED',
        'OUTCOME_NOT_ALLOWED',
      ],
      [
        FEED_TYPE.conversationStarted,
        'DEFERRED_HUMAN_SESSION',
        'OUTCOME_NOT_ALLOWED',
      ],
      [FEED_TYPE.conversationEnded, 'PROVIDER_ACCEPTED', 'APPLY'],
      [FEED_TYPE.conversationEnded, 'STALE', 'APPLY'],
      [
        FEED_TYPE.conversationEnded,
        'DEFERRED_WINDOW_CLOSED',
        'OUTCOME_NOT_ALLOWED',
      ],
      [
        FEED_TYPE.conversationEnded,
        'DEFERRED_HUMAN_SESSION',
        'OUTCOME_NOT_ALLOWED',
      ],
      [FEED_TYPE.staffMessage, 'PROVIDER_ACCEPTED', 'APPLY'],
      [FEED_TYPE.staffMessage, 'DEFERRED_WINDOW_CLOSED', 'APPLY'],
      [FEED_TYPE.staffMessage, 'STALE', 'APPLY'],
      [FEED_TYPE.staffMessage, 'DEFERRED_HUMAN_SESSION', 'OUTCOME_NOT_ALLOWED'],
      [FEED_TYPE.templateRequested, 'PROVIDER_ACCEPTED', 'APPLY'],
      [FEED_TYPE.templateRequested, 'STALE', 'APPLY'],
      [
        FEED_TYPE.templateRequested,
        'DEFERRED_WINDOW_CLOSED',
        'OUTCOME_NOT_ALLOWED',
      ],
      [
        FEED_TYPE.templateRequested,
        'DEFERRED_HUMAN_SESSION',
        'OUTCOME_NOT_ALLOWED',
      ],
    ] as const)('%s + %s -> %s', (type, outcome, expected) =>
      expect(decide(type, outcome)).toBe(expected),
    );
  });
});
