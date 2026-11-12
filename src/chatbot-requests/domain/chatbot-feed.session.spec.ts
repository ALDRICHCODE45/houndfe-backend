import {
  buildConversationEndedPayload,
  buildConversationReassignedPayload,
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
        languageCode: 'es_MX',
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      seq: 18,
      messageId: 'm2',
      templateName: 'reabrir',
      languageCode: 'es_MX',
    });
  });

  it('a staff media message carries mediaId, mimeType, filename and caption (S15 Q5, S16 9)', () => {
    expect(
      buildStaffMessagePayload({
        requestId: 'r',
        handoffEpoch: 3,
        seq: 19,
        messageId: 'm3',
        media: {
          type: 'DOCUMENT',
          mediaId: 'media-1',
          mimeType: 'application/pdf',
          filename: 'cotizacion.pdf',
          caption: 'Su cotización',
        },
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      seq: 19,
      messageId: 'm3',
      type: 'DOCUMENT',
      mediaId: 'media-1',
      mimeType: 'application/pdf',
      filename: 'cotizacion.pdf',
      caption: 'Su cotización',
    });
    expect(
      buildStaffMessagePayload({
        requestId: 'r',
        handoffEpoch: 3,
        seq: 20,
        messageId: 'm4',
        media: {
          type: 'IMAGE',
          mediaId: 'media-2',
          mimeType: 'image/jpeg',
          filename: null,
          caption: null,
        },
      }),
    ).toEqual({
      requestId: 'r',
      handoffEpoch: 3,
      seq: 20,
      messageId: 'm4',
      type: 'IMAGE',
      mediaId: 'media-2',
      mimeType: 'image/jpeg',
      filename: null,
      caption: null,
    });
  });

  it('conversation.reassigned names the new attendee by first name (S15 Q2, S16 10)', () => {
    expect(FEED_TYPE.conversationReassigned).toBe('conversation.reassigned');
    expect(
      buildConversationReassignedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        staffFirstName: 'Luis',
      }),
    ).toEqual({ requestId: 'r', handoffEpoch: 3, staffFirstName: 'Luis' });
    expect(
      buildConversationReassignedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        staffFirstName: null,
      }).staffFirstName,
    ).toBeNull();
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
      resumeNotice: true,
    });
  });

  it('resumeNotice (S15 Q1) is true only for the start revert: the bot sends "seguimos por aquí" if it greeted', () => {
    const ended = (
      reason: Parameters<typeof buildConversationEndedPayload>[0]['reason'],
    ) =>
      buildConversationEndedPayload({
        requestId: 'r',
        handoffEpoch: 3,
        reason,
      });
    expect(ended('FINISHED').resumeNotice).toBe(false);
    expect(ended('FORCED').resumeNotice).toBe(false);
    expect(ended('IDLE_TIMEOUT').resumeNotice).toBe(false);
    expect(ended('START_TIMEOUT').resumeNotice).toBe(true);
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
      [FEED_TYPE.conversationReassigned, 'PROVIDER_ACCEPTED', 'APPLY'],
      [FEED_TYPE.conversationReassigned, 'DELIVERY_UNKNOWN', 'APPLY'],
      [FEED_TYPE.conversationReassigned, 'STALE', 'APPLY'],
      [
        FEED_TYPE.conversationReassigned,
        'DEFERRED_WINDOW_CLOSED',
        'OUTCOME_NOT_ALLOWED',
      ],
      [
        FEED_TYPE.conversationReassigned,
        'DEFERRED_HUMAN_SESSION',
        'OUTCOME_NOT_ALLOWED',
      ],
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
