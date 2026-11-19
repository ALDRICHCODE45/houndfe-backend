/**
 * Unit 10: the `request.answered` payload of a staff clarification reply
 * (contract §3.3 example `{kind: "CLARIFICATION", text, prefix}`, §4.5, L38:
 * the bot composes the wording with each customer's tú/usted; `text`/`prefix`
 * are an usted fallback).
 */
import {
  TEAM_REPLY_PREFIX,
  buildClarificationAnswerPayload,
  classifyOutcome,
  FEED_TYPE,
  hashFeedOutcome,
  type FeedOutcomeInput,
} from './chatbot-feed';

const REPLY_ID = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';
const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const AT = '2026-11-12T16:20:00.000Z';

describe('buildClarificationAnswerPayload', () => {
  it('carries the staff text as written, the team prefix and the reply id for the mirror', () => {
    expect(
      buildClarificationAnswerPayload({
        replyId: REPLY_ID,
        text: 'Sí, es apto desde las 8 semanas.',
      }),
    ).toEqual({
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
      action: 'REPLY',
      replyId: REPLY_ID,
      text: 'Sí, es apto desde las 8 semanas.',
      prefix: TEAM_REPLY_PREFIX,
      staffText: 'Sí, es apto desde las 8 semanas.',
    });
  });

  it('uses the same prefix as every other staff-written answer', () => {
    expect(TEAM_REPLY_PREFIX).toBe('Le comparto la respuesta del equipo:');
  });
});

describe('a clarification answer is acknowledged like any request.answered', () => {
  const delivery = (over: Record<string, unknown> = {}) => ({
    type: FEED_TYPE.answered,
    attemptId: null,
    evidenceHash: null,
    ackedAt: null,
    ...over,
  });
  const input = (outcome: FeedOutcomeInput['outcome']): FeedOutcomeInput => ({
    attemptId: ATTEMPT,
    outcome,
    attemptedAt: AT,
  });

  it.each([
    'PROVIDER_ACCEPTED',
    'DELIVERY_UNKNOWN',
    'DEFERRED_WINDOW_CLOSED',
    'DEFERRED_HUMAN_SESSION',
    'STALE',
  ] as const)('accepts %s', (outcome) => {
    const body: FeedOutcomeInput =
      outcome === 'PROVIDER_ACCEPTED'
        ? { ...input(outcome), providerMessageId: 'wamid.1' }
        : input(outcome);
    expect(classifyOutcome(delivery(), body, hashFeedOutcome(body))).toBe(
      'APPLY',
    );
  });
});
