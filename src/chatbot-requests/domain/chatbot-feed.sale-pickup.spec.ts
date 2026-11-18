/**
 * pay-in-store-pickup / T3 (S2, S3, S6) — the sale-level feed items of a
 * pay-in-store hold: types, payloads and the ACK rules (never deferred).
 */
import {
  buildPickupExpiredPayload,
  buildPickupExtendedPayload,
  buildPickupReminderPayload,
  classifyOutcome,
  FEED_TYPE,
  hashFeedOutcome,
  isSaleFeedType,
  parseFeedOutcome,
} from './chatbot-feed';

const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const OTHER_ATTEMPT = '5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10';
const AT = '2026-11-10T16:20:00.000Z';
const HOLD_UNTIL = new Date('2026-11-19T18:30:00.000Z');

describe('sale.pickup_* feed types (pay-in-store hold, T3)', () => {
  it('adds three sale-level types; the request types are not sale types', () => {
    expect(FEED_TYPE.pickupReminder).toBe('sale.pickup_reminder');
    expect(FEED_TYPE.pickupExpired).toBe('sale.pickup_expired');
    expect(FEED_TYPE.pickupExtended).toBe('sale.pickup_extended');
    expect(isSaleFeedType('sale.pickup_reminder')).toBe(true);
    expect(isSaleFeedType('sale.pickup_expired')).toBe(true);
    expect(isSaleFeedType('sale.pickup_extended')).toBe(true);
    expect(isSaleFeedType(FEED_TYPE.answered)).toBe(false);
    expect(isSaleFeedType(FEED_TYPE.scheduledReminder)).toBe(false);
  });

  it('reminder: saleId, folio, holdUntil, holdVersion and conversationRef', () => {
    expect(
      buildPickupReminderPayload({
        saleId: 's1',
        folio: 'V-000123',
        holdUntil: HOLD_UNTIL,
        holdVersion: 3,
        conversationRef: 'wa:5215512340000',
      }),
    ).toEqual({
      saleId: 's1',
      folio: 'V-000123',
      holdUntil: '2026-11-19T18:30:00.000Z',
      holdVersion: 3,
      conversationRef: 'wa:5215512340000',
    });
  });

  it('expired: no deadline; a missing chat is an explicit null', () => {
    expect(
      buildPickupExpiredPayload({
        saleId: 's1',
        folio: null,
        holdVersion: 1,
        conversationRef: null,
      }),
    ).toEqual({
      saleId: 's1',
      folio: null,
      holdVersion: 1,
      conversationRef: null,
    });
  });

  it('extended: the new deadline and the version it belongs to', () => {
    expect(
      buildPickupExtendedPayload({
        saleId: 's1',
        folio: 'V-000123',
        holdUntil: HOLD_UNTIL,
        holdVersion: 2,
        conversationRef: null,
      }),
    ).toEqual({
      saleId: 's1',
      folio: 'V-000123',
      holdUntil: '2026-11-19T18:30:00.000Z',
      holdVersion: 2,
      conversationRef: null,
    });
  });

  describe.each([
    FEED_TYPE.pickupReminder,
    FEED_TYPE.pickupExpired,
    FEED_TYPE.pickupExtended,
  ])('%s outcomes: sent, unknown or stale, never deferred', (type) => {
    const fresh = { type, attemptId: null, evidenceHash: null, ackedAt: null };
    const body = (outcome: string, attemptId = ATTEMPT) =>
      parseFeedOutcome({
        attemptId,
        outcome,
        ...(outcome === 'PROVIDER_ACCEPTED'
          ? { providerMessageId: 'wamid.1', attemptedAt: AT }
          : outcome === 'STALE'
            ? {}
            : { attemptedAt: AT }),
      });

    it.each(['PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'STALE'])(
      'accepts %s',
      (outcome) => {
        const input = body(outcome);
        expect(classifyOutcome(fresh, input, hashFeedOutcome(input))).toBe(
          'APPLY',
        );
      },
    );

    it.each(['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION'])(
      'refuses %s (a late hold notice is useless)',
      (outcome) => {
        const input = body(outcome);
        expect(classifyOutcome(fresh, input, hashFeedOutcome(input))).toBe(
          'OUTCOME_NOT_ALLOWED',
        );
      },
    );

    it('one terminal ACK: same attempt replays, another attempt is already recorded', () => {
      const input = body('PROVIDER_ACCEPTED');
      const hash = hashFeedOutcome(input);
      const acked = {
        type,
        attemptId: ATTEMPT,
        evidenceHash: hash,
        ackedAt: new Date(AT),
      };
      expect(classifyOutcome(acked, input, hash)).toBe('REPLAY');
      const other = body('STALE', OTHER_ATTEMPT);
      expect(classifyOutcome(acked, other, hashFeedOutcome(other))).toBe(
        'OUTCOME_ALREADY_RECORDED',
      );
    });
  });
});
