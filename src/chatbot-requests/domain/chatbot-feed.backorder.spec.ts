/**
 * restock-backorder / T2b (S1 §10, S2 D3 Q6) — the `backorder.*` feed items:
 * types, payloads, the ACK rules (deferrals refused; the new terminal outcome
 * `PROVIDER_REJECTED` only for backorder items) and the proof that nothing the
 * bot already relies on moved (existing types, outcomes and evidence hashes).
 */
import {
  buildBackorderCancelledByStaffPayload,
  buildBackorderEtaUnavailablePayload,
  buildBackorderEtaUpdatedPayload,
  buildBackorderReservationExpiredPayload,
  buildBackorderReservationLostPayload,
  buildBackorderReservationReminderPayload,
  buildBackorderReservedPayload,
  classifyOutcome,
  FEED_OUTCOMES,
  FEED_TYPE,
  hashFeedOutcome,
  isBackorderFeedType,
  isDeferredOutcome,
  parseFeedOutcome,
} from './chatbot-feed';

const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const OTHER_ATTEMPT = '5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10';
const AT = '2026-11-10T16:20:00.000Z';

const COMMON = {
  backorderId: 'b1',
  folio: 'BO-000012',
  productName: 'Croquetas Adulto 18 kg',
  variantName: null,
  quantity: 2,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  version: 3,
};

const COMMON_PAYLOAD = {
  backorderId: 'b1',
  folio: 'BO-000012',
  productName: 'Croquetas Adulto 18 kg',
  variantName: null,
  quantity: 2,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  version: 3,
};

const BACKORDER_TYPES = [
  FEED_TYPE.backorderReserved,
  FEED_TYPE.backorderReservationReminder,
  FEED_TYPE.backorderReservationExpired,
  FEED_TYPE.backorderCancelledByStaff,
  FEED_TYPE.backorderEtaUpdated,
  FEED_TYPE.backorderEtaUnavailable,
  FEED_TYPE.backorderReservationLost,
] as const;

describe('backorder.* feed types (restock-backorder T2b)', () => {
  it('adds the seven contract §10 types', () => {
    expect(BACKORDER_TYPES).toEqual([
      'backorder.reserved',
      'backorder.reservation_reminder',
      'backorder.reservation_expired',
      'backorder.cancelled_by_staff',
      'backorder.eta_updated',
      'backorder.eta_unavailable',
      'backorder.reservation_lost',
    ]);
    for (const type of BACKORDER_TYPES) {
      expect(isBackorderFeedType(type)).toBe(true);
    }
  });

  it('request, conversation and sale types are not backorder types', () => {
    for (const type of [
      FEED_TYPE.answered,
      FEED_TYPE.cancelled,
      FEED_TYPE.merged,
      FEED_TYPE.overdueNotice,
      FEED_TYPE.staffMessage,
      FEED_TYPE.scheduledReminder,
      FEED_TYPE.pickupReminder,
      FEED_TYPE.pickupExpired,
      'backorder.unknown',
    ]) {
      expect(isBackorderFeedType(type)).toBe(false);
    }
  });
});

describe('backorder.* payloads (contract §10)', () => {
  it('reserved: prices, the 24 h deadline and the reminder, UTC Z', () => {
    expect(
      buildBackorderReservedPayload({
        ...COMMON,
        referencePriceCents: 114900,
        currentPriceCents: 109900,
        finalPriceCents: 109900,
        reservedUntil: new Date('2026-11-21T15:00:00.000Z'),
        reminderAt: new Date('2026-11-21T12:00:00.000Z'),
      }),
    ).toEqual({
      ...COMMON_PAYLOAD,
      referencePriceCents: 114900,
      currentPriceCents: 109900,
      finalPriceCents: 109900,
      reservedUntil: '2026-11-21T15:00:00.000Z',
      reminderAt: '2026-11-21T12:00:00.000Z',
    });
  });

  it('reminder: only the deadline', () => {
    expect(
      buildBackorderReservationReminderPayload({
        ...COMMON,
        reservedUntil: new Date('2026-11-21T15:00:00.000Z'),
      }),
    ).toEqual({ ...COMMON_PAYLOAD, reservedUntil: '2026-11-21T15:00:00.000Z' });
  });

  it('expired: expiredAt', () => {
    expect(
      buildBackorderReservationExpiredPayload({
        ...COMMON,
        expiredAt: new Date('2026-11-21T15:00:01.000Z'),
      }),
    ).toEqual({ ...COMMON_PAYLOAD, expiredAt: '2026-11-21T15:00:01.000Z' });
  });

  it('cancelled_by_staff: the reason, an explicit null when staff gave none', () => {
    expect(
      buildBackorderCancelledByStaffPayload({ ...COMMON, reason: 'Sin stock' }),
    ).toEqual({ ...COMMON_PAYLOAD, reason: 'Sin stock' });
    expect(
      buildBackorderCancelledByStaffPayload({ ...COMMON, reason: null }),
    ).toEqual({ ...COMMON_PAYLOAD, reason: null });
  });

  it('eta_updated: estimatedAt and restockDays; eta_unavailable: nothing more', () => {
    expect(
      buildBackorderEtaUpdatedPayload({
        ...COMMON,
        estimatedAt: new Date('2026-11-27T15:00:00.000Z'),
        restockDays: 7,
      }),
    ).toEqual({
      ...COMMON_PAYLOAD,
      estimatedAt: '2026-11-27T15:00:00.000Z',
      restockDays: 7,
    });
    expect(buildBackorderEtaUnavailablePayload(COMMON)).toEqual(COMMON_PAYLOAD);
  });

  it('reservation_lost: reason LOT_EXPIRED, the queue position and the estimate', () => {
    expect(
      buildBackorderReservationLostPayload({
        ...COMMON,
        queuePosition: 1,
        estimatedAt: new Date('2026-11-27T15:00:00.000Z'),
      }),
    ).toEqual({
      ...COMMON_PAYLOAD,
      reason: 'LOT_EXPIRED',
      queuePosition: 1,
      estimatedAt: '2026-11-27T15:00:00.000Z',
    });
  });
});

describe('the outcome body of a backorder item (PROVIDER_REJECTED)', () => {
  const rejected = (extra: Record<string, unknown> = {}) => ({
    attemptId: ATTEMPT,
    outcome: 'PROVIDER_REJECTED',
    attemptedAt: AT,
    reason: 'TEMPLATE_NOT_APPROVED',
    ...extra,
  });

  it('is a terminal outcome, not a deferral', () => {
    expect(FEED_OUTCOMES).toContain('PROVIDER_REJECTED');
    expect(isDeferredOutcome('PROVIDER_REJECTED')).toBe(false);
  });

  it('parses {attemptId, outcome, attemptedAt, reason}', () => {
    expect(parseFeedOutcome(rejected())).toEqual({
      attemptId: ATTEMPT,
      outcome: 'PROVIDER_REJECTED',
      attemptedAt: AT,
      reason: 'TEMPLATE_NOT_APPROVED',
    });
  });

  it('requires a reason of 1 to 280 characters (trimmed)', () => {
    const { reason: _omitted, ...withoutReason } = rejected();
    void _omitted;
    expect(() => parseFeedOutcome(withoutReason)).toThrow();
    expect(() => parseFeedOutcome(rejected({ reason: '' }))).toThrow();
    expect(() => parseFeedOutcome(rejected({ reason: '   ' }))).toThrow();
    expect(() => parseFeedOutcome(rejected({ reason: 7 }))).toThrow();
    expect(() =>
      parseFeedOutcome(rejected({ reason: 'x'.repeat(281) })),
    ).toThrow();
    expect(
      parseFeedOutcome(rejected({ reason: ` ${'x'.repeat(280)} ` })).reason,
    ).toBe('x'.repeat(280));
  });

  it('requires attemptedAt and forbids a providerMessageId', () => {
    const { attemptedAt: _omitted, ...withoutAt } = rejected();
    void _omitted;
    expect(() => parseFeedOutcome(withoutAt)).toThrow();
    expect(() =>
      parseFeedOutcome(rejected({ providerMessageId: 'wamid.1' })),
    ).toThrow();
  });

  it('reason belongs only to PROVIDER_REJECTED: every other outcome with one is a 400', () => {
    for (const outcome of [
      'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN',
      'STALE',
      'DEFERRED_WINDOW_CLOSED',
      'DEFERRED_HUMAN_SESSION',
    ]) {
      expect(() =>
        parseFeedOutcome({
          attemptId: ATTEMPT,
          outcome,
          attemptedAt: AT,
          reason: 'x',
          ...(outcome === 'PROVIDER_ACCEPTED'
            ? { providerMessageId: 'wamid.1' }
            : {}),
        }),
      ).toThrow();
    }
  });

  it('the reason is part of the evidence: another reason is another hash', () => {
    const a = hashFeedOutcome(parseFeedOutcome(rejected()));
    const b = hashFeedOutcome(parseFeedOutcome(rejected({ reason: 'OTHER' })));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('existing outcomes keep their evidence hash (replays of stored ACKs)', () => {
  it.each([
    [
      'PROVIDER_ACCEPTED',
      { providerMessageId: 'wamid.1', attemptedAt: AT },
      '078d868c04a478da8c27d31b2a6dd85030860eaa92fb7d3a8339caa2c9c5da3d',
    ],
    [
      'DELIVERY_UNKNOWN',
      { attemptedAt: AT },
      'a0e64035b15903cbbe5fc1a0cf0b652d68d2d16020c1720da85ca6182123d670',
    ],
    [
      'STALE',
      {},
      '5b30dbfab696c1dcaf2458ca6f0fe8ef0c618b7fd41b4953d40831e0ee645086',
    ],
  ])('%s hashes exactly as before this change', (outcome, extra, expected) => {
    const input = parseFeedOutcome({ attemptId: ATTEMPT, outcome, ...extra });
    expect(hashFeedOutcome(input)).toBe(expected);
  });
});

describe('classifyOutcome: backorder items', () => {
  const fresh = (type: string) => ({
    type,
    attemptId: null,
    evidenceHash: null,
    ackedAt: null,
  });
  const outcome = (name: string, attemptId = ATTEMPT) =>
    parseFeedOutcome({
      attemptId,
      outcome: name,
      ...(name === 'PROVIDER_ACCEPTED'
        ? { providerMessageId: 'wamid.1', attemptedAt: AT }
        : name === 'STALE'
          ? {}
          : { attemptedAt: AT }),
      ...(name === 'PROVIDER_REJECTED' ? { reason: 'UNREACHABLE' } : {}),
    });
  const decide = (type: string, name: string) => {
    const input = outcome(name);
    return classifyOutcome(fresh(type), input, hashFeedOutcome(input));
  };

  describe.each(BACKORDER_TYPES)('%s', (type) => {
    it.each([
      'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN',
      'STALE',
      'PROVIDER_REJECTED',
    ])('accepts %s', (name) => {
      expect(decide(type, name)).toBe('APPLY');
    });

    it.each(['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION'])(
      'refuses %s (a late arrival notice is useless: OUTCOME_NOT_ALLOWED)',
      (name) => {
        expect(decide(type, name)).toBe('OUTCOME_NOT_ALLOWED');
      },
    );

    it('one terminal ACK: same attempt replays, another attempt is already recorded', () => {
      const input = outcome('PROVIDER_REJECTED');
      const hash = hashFeedOutcome(input);
      const acked = {
        type,
        attemptId: ATTEMPT,
        evidenceHash: hash,
        ackedAt: new Date(AT),
      };
      expect(classifyOutcome(acked, input, hash)).toBe('REPLAY');
      const other = outcome('STALE', OTHER_ATTEMPT);
      expect(classifyOutcome(acked, other, hashFeedOutcome(other))).toBe(
        'OUTCOME_ALREADY_RECORDED',
      );
      const sameAttemptOtherEvidence = parseFeedOutcome({
        attemptId: ATTEMPT,
        outcome: 'PROVIDER_REJECTED',
        attemptedAt: AT,
        reason: 'ANOTHER',
      });
      expect(
        classifyOutcome(
          acked,
          sameAttemptOtherEvidence,
          hashFeedOutcome(sameAttemptOtherEvidence),
        ),
      ).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe.each([
    FEED_TYPE.answered,
    FEED_TYPE.cancelled,
    FEED_TYPE.merged,
    FEED_TYPE.overdueNotice,
    FEED_TYPE.staffMessage,
    FEED_TYPE.templateRequested,
    FEED_TYPE.conversationStarted,
    FEED_TYPE.scheduledReminder,
    FEED_TYPE.pickupReminder,
    FEED_TYPE.pickupExpiredReview,
  ])('%s (not a backorder item)', (type) => {
    it('refuses PROVIDER_REJECTED: OUTCOME_NOT_ALLOWED', () => {
      expect(decide(type, 'PROVIDER_REJECTED')).toBe('OUTCOME_NOT_ALLOWED');
    });
  });
});

describe('classifyOutcome: the existing rules are unchanged', () => {
  const fresh = (type: string) => ({
    type,
    attemptId: null,
    evidenceHash: null,
    ackedAt: null,
  });
  const decide = (type: string, name: string) => {
    const input = parseFeedOutcome({
      attemptId: ATTEMPT,
      outcome: name,
      ...(name === 'PROVIDER_ACCEPTED'
        ? { providerMessageId: 'wamid.1', attemptedAt: AT }
        : name === 'STALE'
          ? {}
          : { attemptedAt: AT }),
    });
    return classifyOutcome(fresh(type), input, hashFeedOutcome(input));
  };

  it('an answer may still be deferred for either reason', () => {
    expect(decide(FEED_TYPE.answered, 'DEFERRED_WINDOW_CLOSED')).toBe('APPLY');
    expect(decide(FEED_TYPE.answered, 'DEFERRED_HUMAN_SESSION')).toBe('APPLY');
  });

  it('sale-level items and the never-deferred request types still refuse a deferral', () => {
    for (const type of [
      FEED_TYPE.pickupReminder,
      FEED_TYPE.pickupExpired,
      FEED_TYPE.cancelled,
      FEED_TYPE.overdueNotice,
      FEED_TYPE.scheduledReminder,
    ]) {
      expect(decide(type, 'DEFERRED_WINDOW_CLOSED')).toBe(
        'OUTCOME_NOT_ALLOWED',
      );
    }
  });

  it('a staff message may wait for the window, never for a human session', () => {
    expect(decide(FEED_TYPE.staffMessage, 'DEFERRED_WINDOW_CLOSED')).toBe(
      'APPLY',
    );
    expect(decide(FEED_TYPE.staffMessage, 'DEFERRED_HUMAN_SESSION')).toBe(
      'OUTCOME_NOT_ALLOWED',
    );
  });

  it('request.merged only accepts STALE', () => {
    expect(decide(FEED_TYPE.merged, 'STALE')).toBe('APPLY');
    expect(decide(FEED_TYPE.merged, 'PROVIDER_ACCEPTED')).toBe(
      'OUTCOME_NOT_ALLOWED',
    );
  });

  it('the old outcome list is a prefix of the new one', () => {
    expect(FEED_OUTCOMES.slice(0, 5)).toEqual([
      'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN',
      'DEFERRED_WINDOW_CLOSED',
      'DEFERRED_HUMAN_SESSION',
      'STALE',
    ]);
  });

  it('an unknown outcome and a reason on any other outcome stay 400', () => {
    expect(() =>
      parseFeedOutcome({ attemptId: ATTEMPT, outcome: 'PROVIDER_EXPLODED' }),
    ).toThrow();
  });
});
