import { DEFAULT_CUSTOMER_REJECTION_REASON } from '../../sales/review/receipt-review.service';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  buildAnswerPayload,
  buildCancelPayload,
  buildMergedPayload,
  classifyOutcome,
  deferredReasonOf,
  FEED_LIMITS,
  FEED_TYPE,
  LEGACY_DEFAULT_REJECTION_TEXT,
  formatCursor,
  hashFeedOutcome,
  parseCursor,
  parseFeedOutcome,
  parseFeedQuery,
  TEAM_REPLY_PREFIX,
} from './chatbot-feed';

const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const OTHER_ATTEMPT = '5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10';
const AT = '2026-11-10T16:20:00.000Z';

describe('feed cursor and query (§3.3)', () => {
  it('formats the cursor as 12 zero-padded digits and parses it back', () => {
    expect(formatCursor(1842n)).toBe('000000001842');
    expect(parseCursor('000000001842')).toBe(1842n);
  });

  it('treats a missing cursor as the start of the retained feed', () => {
    expect(parseCursor(undefined)).toBe(0n);
  });

  it.each(['abc', '-1', '1.5', '', ' 7', '9'.repeat(19)])(
    'rejects the cursor %p',
    (raw) => {
      expect(() => parseCursor(raw)).toThrow(InvalidArgumentError);
    },
  );

  it('defaults to 50 items and a 25 s wait', () => {
    expect(parseFeedQuery({})).toEqual({
      after: 0n,
      limit: FEED_LIMITS.defaultLimit,
      waitSeconds: FEED_LIMITS.defaultWaitSeconds,
    });
  });

  it('accepts waitSeconds=0 (no long-poll) and the limits', () => {
    expect(
      parseFeedQuery({ after: '5', limit: '10', waitSeconds: '0' }),
    ).toEqual({ after: 5n, limit: 10, waitSeconds: 0 });
  });

  it.each([
    { limit: '0' },
    { limit: '51' },
    { limit: 'x' },
    { waitSeconds: '26' },
    { waitSeconds: '-1' },
    { waitSeconds: '1.5' },
  ])('rejects %p instead of clamping it', (query) => {
    expect(() => parseFeedQuery(query)).toThrow(InvalidArgumentError);
  });
});

describe('delivery outcome body (§3.3)', () => {
  it('accepts PROVIDER_ACCEPTED with attemptedAt and providerMessageId', () => {
    expect(
      parseFeedOutcome({
        attemptId: ATTEMPT,
        outcome: 'PROVIDER_ACCEPTED',
        attemptedAt: AT,
        providerMessageId: 'wamid.HBg1',
      }),
    ).toEqual({
      attemptId: ATTEMPT,
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt: AT,
      providerMessageId: 'wamid.HBg1',
    });
  });

  it('lets STALE carry only the attempt id', () => {
    expect(parseFeedOutcome({ attemptId: ATTEMPT, outcome: 'STALE' })).toEqual({
      attemptId: ATTEMPT,
      outcome: 'STALE',
    });
  });

  it('accepts DEFERRED_HUMAN_SESSION with attemptedAt only', () => {
    expect(
      parseFeedOutcome({
        attemptId: ATTEMPT,
        outcome: 'DEFERRED_HUMAN_SESSION',
        attemptedAt: AT,
      }),
    ).toEqual({
      attemptId: ATTEMPT,
      outcome: 'DEFERRED_HUMAN_SESSION',
      attemptedAt: AT,
    });
  });

  it('keeps providerMessageId optional on DELIVERY_UNKNOWN', () => {
    expect(
      parseFeedOutcome({
        attemptId: ATTEMPT,
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
      }),
    ).toEqual({
      attemptId: ATTEMPT,
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt: AT,
    });
  });

  it.each([
    ['FAILED is not an outcome', { outcome: 'FAILED', attemptedAt: AT }],
    ['an unknown key', { outcome: 'STALE', tenantId: 't' }],
    ['a missing attemptId', { outcome: 'STALE', attemptId: undefined }],
    ['a non-UUID attemptId', { outcome: 'STALE', attemptId: 'nope' }],
    [
      'PROVIDER_ACCEPTED without a message id',
      { outcome: 'PROVIDER_ACCEPTED', attemptedAt: AT },
    ],
    [
      'PROVIDER_ACCEPTED without attemptedAt',
      { outcome: 'PROVIDER_ACCEPTED', providerMessageId: 'w' },
    ],
    [
      'a non-canonical attemptedAt',
      { outcome: 'DELIVERY_UNKNOWN', attemptedAt: '2026-11-10T16:20:00Z' },
    ],
    ['a message id on STALE', { outcome: 'STALE', providerMessageId: 'w' }],
    [
      'a message id on DEFERRED_WINDOW_CLOSED',
      {
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptedAt: AT,
        providerMessageId: 'w',
      },
    ],
    [
      'a message id on DEFERRED_HUMAN_SESSION',
      {
        outcome: 'DEFERRED_HUMAN_SESSION',
        attemptedAt: AT,
        providerMessageId: 'w',
      },
    ],
    [
      'DEFERRED_HUMAN_SESSION without attemptedAt',
      { outcome: 'DEFERRED_HUMAN_SESSION' },
    ],
    [
      'a blank message id',
      { outcome: 'DELIVERY_UNKNOWN', attemptedAt: AT, providerMessageId: ' ' },
    ],
    [
      'an over-long message id',
      {
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
        providerMessageId: 'x'.repeat(513),
      },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseFeedOutcome({ attemptId: ATTEMPT, ...body })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a body that is not an object', () => {
    expect(() => parseFeedOutcome(null)).toThrow(InvalidArgumentError);
    expect(() => parseFeedOutcome([])).toThrow(InvalidArgumentError);
  });

  it('hashes the same evidence the same way and other evidence differently', () => {
    const a = parseFeedOutcome({
      attemptId: ATTEMPT,
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt: AT,
    });
    const same = parseFeedOutcome({
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt: AT,
      attemptId: ATTEMPT,
    });
    const other = parseFeedOutcome({ attemptId: ATTEMPT, outcome: 'STALE' });
    expect(hashFeedOutcome(a)).toBe(hashFeedOutcome(same));
    expect(hashFeedOutcome(a)).not.toBe(hashFeedOutcome(other));
  });
});

describe('classifyOutcome: one terminal ACK per delivery (HumanDecisionBotOutcome semantics)', () => {
  const input = (over: object = {}) =>
    parseFeedOutcome({
      attemptId: ATTEMPT,
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt: AT,
      providerMessageId: 'w1',
      ...over,
    });
  const pending = {
    type: FEED_TYPE.answered,
    attemptId: null,
    evidenceHash: null,
    ackedAt: null,
  };
  const terminal = (hash: string, attemptId = ATTEMPT) => ({
    type: FEED_TYPE.answered,
    attemptId,
    evidenceHash: hash,
    ackedAt: new Date(AT),
  });

  it('applies the first outcome', () => {
    const body = input();
    expect(classifyOutcome(pending, body, hashFeedOutcome(body))).toBe('APPLY');
  });

  it('replays the same attempt and evidence', () => {
    const body = input();
    const hash = hashFeedOutcome(body);
    expect(classifyOutcome(terminal(hash), body, hash)).toBe('REPLAY');
  });

  it('flags the same attempt with other evidence as an idempotency conflict', () => {
    const first = input();
    const changed = input({ providerMessageId: 'w2' });
    expect(
      classifyOutcome(
        terminal(hashFeedOutcome(first)),
        changed,
        hashFeedOutcome(changed),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses another attempt once a terminal outcome exists', () => {
    const first = input();
    const second = input({
      attemptId: OTHER_ATTEMPT,
      outcome: 'STALE',
      attemptedAt: undefined,
      providerMessageId: undefined,
    });
    expect(
      classifyOutcome(
        terminal(hashFeedOutcome(first)),
        second,
        hashFeedOutcome(second),
      ),
    ).toBe('OUTCOME_ALREADY_RECORDED');
  });

  describe('DEFERRED_WINDOW_CLOSED keeps the delivery pending', () => {
    const deferred = input({
      outcome: 'DEFERRED_WINDOW_CLOSED',
      providerMessageId: undefined,
    });
    const deferredHash = hashFeedOutcome(deferred);
    const deferredRow = {
      type: FEED_TYPE.answered,
      attemptId: ATTEMPT,
      evidenceHash: deferredHash,
      ackedAt: null,
    };

    it('replays the same deferral', () => {
      expect(classifyOutcome(deferredRow, deferred, deferredHash)).toBe(
        'REPLAY',
      );
    });

    it('lets a later attempt end it with a terminal outcome', () => {
      const accepted = input({ attemptId: OTHER_ATTEMPT });
      expect(
        classifyOutcome(deferredRow, accepted, hashFeedOutcome(accepted)),
      ).toBe('APPLY');
    });

    it('lets a later attempt defer again', () => {
      const again = input({
        attemptId: OTHER_ATTEMPT,
        outcome: 'DEFERRED_WINDOW_CLOSED',
        providerMessageId: undefined,
      });
      expect(classifyOutcome(deferredRow, again, hashFeedOutcome(again))).toBe(
        'APPLY',
      );
    });

    it('is not allowed for a staff cancellation notice (§12.14)', () => {
      expect(
        classifyOutcome(
          { ...pending, type: FEED_TYPE.cancelled },
          deferred,
          deferredHash,
        ),
      ).toBe('OUTCOME_NOT_ALLOWED');
    });
  });
});

describe('DEFERRED_HUMAN_SESSION keeps the delivery pending like the window deferral', () => {
  const input = (over: object = {}) =>
    parseFeedOutcome({
      attemptId: ATTEMPT,
      outcome: 'DEFERRED_HUMAN_SESSION',
      attemptedAt: AT,
      ...over,
    });
  const deferred = input();
  const deferredHash = hashFeedOutcome(deferred);
  const deferredRow = {
    type: FEED_TYPE.answered,
    attemptId: ATTEMPT,
    evidenceHash: deferredHash,
    ackedAt: null,
  };
  const fresh = {
    type: FEED_TYPE.answered,
    attemptId: null,
    evidenceHash: null,
    ackedAt: null,
  };

  it('applies on a fresh delivery and replays the same deferral', () => {
    expect(classifyOutcome(fresh, deferred, deferredHash)).toBe('APPLY');
    expect(classifyOutcome(deferredRow, deferred, deferredHash)).toBe('REPLAY');
  });

  it('lets a later attempt end it, or defer for either reason', () => {
    for (const later of [
      input({
        attemptId: OTHER_ATTEMPT,
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'w1',
      }),
      input({ attemptId: OTHER_ATTEMPT }),
      input({ attemptId: OTHER_ATTEMPT, outcome: 'DEFERRED_WINDOW_CLOSED' }),
    ]) {
      expect(classifyOutcome(deferredRow, later, hashFeedOutcome(later))).toBe(
        'APPLY',
      );
    }
  });

  it('is not allowed for a staff cancellation notice, same rule as the window deferral (§12.14)', () => {
    expect(
      classifyOutcome(
        { ...fresh, type: FEED_TYPE.cancelled },
        deferred,
        deferredHash,
      ),
    ).toBe('OUTCOME_NOT_ALLOWED');
  });

  it('names the deferral reason of each non-terminal outcome', () => {
    expect(deferredReasonOf('DEFERRED_WINDOW_CLOSED')).toBe('WINDOW_CLOSED');
    expect(deferredReasonOf('DEFERRED_HUMAN_SESSION')).toBe('HUMAN_SESSION');
    expect(deferredReasonOf('PROVIDER_ACCEPTED')).toBeNull();
    expect(deferredReasonOf('STALE')).toBeNull();
    expect(deferredReasonOf(null)).toBeNull();
  });
});

describe('request.answered payload (the bot composes from the fields; text is an usted fallback)', () => {
  it('tells a restock estimate with the structured fields the bot needs', () => {
    expect(
      buildAnswerPayload({
        subtype: 'RESTOCK',
        legacyId: 'hd-1',
        productName: 'Croquetas',
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
      }),
    ).toEqual({
      kind: 'DECISION',
      subtype: 'RESTOCK',
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      legacyId: 'hd-1',
      text: 'El producto «Croquetas» estará disponible en aproximadamente 7 días.',
      prefix: null,
      productName: 'Croquetas',
      restockDays: 7,
    });
  });

  it('uses the singular for one day and omits the days when unavailable', () => {
    const one = buildAnswerPayload({
      subtype: 'RESTOCK',
      legacyId: 'hd-1',
      productName: 'X',
      action: 'PROVIDE_RESTOCK_ESTIMATE',
      restockDays: 1,
    });
    expect(one.text).toContain('1 día.');
    const none = buildAnswerPayload({
      subtype: 'RESTOCK',
      legacyId: 'hd-1',
      productName: 'X',
      action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      restockDays: null,
    });
    expect(none).not.toHaveProperty('restockDays');
    expect(none).toMatchObject({ productName: 'X', subtype: 'RESTOCK' });
    expect(none.text).toBe(
      'Por ahora no tenemos una fecha estimada de reposición para «X».',
    );
  });

  it('relays the staff expiration text as staffText with the team prefix', () => {
    expect(
      buildAnswerPayload({
        subtype: 'EXPIRATION',
        legacyId: 'hd-2',
        productName: 'Leche',
        action: 'PROVIDE_EXPIRATION_TEXT',
        expirationText: 'Caduca en marzo 2027',
      }),
    ).toMatchObject({
      action: 'PROVIDE_EXPIRATION_TEXT',
      productName: 'Leche',
      text: 'Caduca en marzo 2027',
      prefix: TEAM_REPLY_PREFIX,
      expirationText: 'Caduca en marzo 2027',
      staffText: 'Caduca en marzo 2027',
    });
    const none = buildAnswerPayload({
      subtype: 'EXPIRATION',
      legacyId: 'hd-2',
      productName: 'Leche',
      action: 'REPORT_EXPIRATION_UNAVAILABLE',
      expirationText: null,
    });
    expect(none.text).toBe(
      'Por ahora no tenemos la fecha de caducidad de «Leche».',
    );
    expect(none).not.toHaveProperty('staffText');
  });

  describe('delivery zone', () => {
    const base = {
      subtype: 'DELIVERY_ZONE' as const,
      legacyId: 'dzr-1',
      zipCode: '06600',
    };

    it('FREE, with the ETA', () => {
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'FREE',
          surchargeCents: null,
          etaDays: 2,
        }),
      ).toMatchObject({
        action: 'APPROVE_DELIVERY_ZONE',
        zoneType: 'FREE',
        zipCode: '06600',
        etaDays: 2,
        text: 'Sí entregamos en su código postal (06600), sin costo de envío. Tiempo estimado: 2 días.',
      });
    });

    it('SURCHARGE renders the amount es-MX with a thousands separator', () => {
      const payload = buildAnswerPayload({
        ...base,
        zoneType: 'SURCHARGE',
        surchargeCents: 125_000,
        etaDays: null,
      });
      expect(payload).toMatchObject({ surchargeCents: 125_000 });
      expect(payload.text).toBe(
        'Sí entregamos en su código postal (06600) con un cargo de envío de $1,250.00 MXN.',
      );
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'SURCHARGE',
          surchargeCents: 5_000,
          etaDays: null,
        }).text,
      ).toContain('$50.00 MXN');
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'SURCHARGE',
          surchargeCents: 123_456_789,
          etaDays: null,
        }).text,
      ).toContain('$1,234,567.89 MXN');
    });

    it.each([null, 0])(
      'SURCHARGE with no amount (%p) never renders $0.00',
      (surchargeCents) => {
        const payload = buildAnswerPayload({
          ...base,
          zoneType: 'SURCHARGE',
          surchargeCents,
          etaDays: 3,
        });
        expect(payload.text).toBe(
          'Sí entregamos en su código postal (06600) con un cargo de envío adicional. Tiempo estimado: 3 días.',
        );
        expect(payload.text).not.toContain('$');
      },
    );

    it('CARRIER_ONLY includes the surcharge when it is set', () => {
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'CARRIER_ONLY',
          surchargeCents: 9_900,
          etaDays: 4,
        }).text,
      ).toBe(
        'En su código postal (06600) el envío es solo por paquetería. El cargo de envío es de $99.00 MXN. Tiempo estimado: 4 días.',
      );
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'CARRIER_ONLY',
          surchargeCents: null,
          etaDays: null,
        }).text,
      ).toBe('En su código postal (06600) el envío es solo por paquetería.');
    });

    it('DENIED rejects', () => {
      expect(
        buildAnswerPayload({
          ...base,
          zoneType: 'DENIED',
          surchargeCents: null,
          etaDays: null,
        }),
      ).toMatchObject({
        action: 'REJECT_DELIVERY_ZONE',
        zoneType: 'DENIED',
        text: 'Por ahora no entregamos en su código postal (06600).',
      });
    });
  });

  describe('transfer receipt', () => {
    const receipt = (
      status: 'CONFIRMED' | 'REJECTED',
      customerReason: string | null,
    ) =>
      buildAnswerPayload({
        subtype: 'TRANSFER_RECEIPT',
        legacyId: 'r-1',
        status,
        customerReason,
      });

    it('confirms in usted with no prefix', () => {
      expect(receipt('CONFIRMED', null)).toMatchObject({
        action: 'CONFIRM_RECEIPT',
        text: 'Le confirmamos la recepción de su comprobante de pago. ¡Gracias!',
        prefix: null,
      });
    });

    it('a staff reason is staffText with the team prefix and reasonSource STAFF', () => {
      expect(receipt('REJECTED', 'La imagen no se ve')).toMatchObject({
        action: 'REJECT_RECEIPT',
        customerReason: 'La imagen no se ve',
        staffText: 'La imagen no se ve',
        reasonSource: 'STAFF',
        text: 'La imagen no se ve',
        prefix: TEAM_REPLY_PREFIX,
      });
    });

    it('L1: the legacy default reason is not staff text: DEFAULT, no prefix, no staffText', () => {
      const payload = receipt('REJECTED', LEGACY_DEFAULT_REJECTION_TEXT);
      expect(payload).toMatchObject({
        reasonSource: 'DEFAULT',
        customerReason: LEGACY_DEFAULT_REJECTION_TEXT,
        text: LEGACY_DEFAULT_REJECTION_TEXT,
        prefix: null,
      });
      expect(payload).not.toHaveProperty('staffText');
    });

    it('a missing reason falls back to the same legacy text, verbatim', () => {
      expect(receipt('REJECTED', null)).toMatchObject({
        reasonSource: 'DEFAULT',
        customerReason: LEGACY_DEFAULT_REJECTION_TEXT,
        text: LEGACY_DEFAULT_REJECTION_TEXT,
        prefix: null,
      });
    });

    it('keeps the copy of the legacy default identical to the sales module constant', () => {
      expect(LEGACY_DEFAULT_REJECTION_TEXT).toBe(
        DEFAULT_CUSTOMER_REJECTION_REASON,
      );
    });
  });
});

describe('request.cancelled payload (§12.14)', () => {
  it('carries requestId, reason, cancelledBy and the optional customerNote', () => {
    expect(
      buildCancelPayload({ requestId: 'r1', reason: 'DUPLICATE' }),
    ).toEqual({
      requestId: 'r1',
      reason: 'DUPLICATE',
      cancelledBy: 'STAFF',
    });
    expect(
      buildCancelPayload({
        requestId: 'r1',
        reason: 'OTHER',
        customerNote: 'Lo vemos mañana',
      }),
    ).toEqual({
      requestId: 'r1',
      reason: 'OTHER',
      cancelledBy: 'STAFF',
      customerNote: 'Lo vemos mañana',
    });
  });
});

describe('request.merged (informational feed item)', () => {
  it('is its own feed type', () => {
    expect(FEED_TYPE.merged).toBe('request.merged');
  });

  it('carries the source, the target and the conversation, and nothing else', () => {
    expect(
      buildMergedPayload({
        requestId: 'src',
        intoRequestId: 'dst',
        conversationRef: 'wa:525512345678',
      }),
    ).toEqual({
      requestId: 'src',
      intoRequestId: 'dst',
      conversationRef: 'wa:525512345678',
    });
  });

  describe('outcomes: only STALE is allowed', () => {
    const merged = {
      type: FEED_TYPE.merged,
      attemptId: null,
      evidenceHash: null,
      ackedAt: null,
    };
    const body = (outcome: string) =>
      parseFeedOutcome({
        attemptId: ATTEMPT,
        outcome,
        ...(outcome === 'PROVIDER_ACCEPTED'
          ? { providerMessageId: 'w1', attemptedAt: AT }
          : outcome === 'STALE'
            ? {}
            : { attemptedAt: AT }),
      });

    it('accepts STALE', () => {
      const stale = body('STALE');
      expect(classifyOutcome(merged, stale, hashFeedOutcome(stale))).toBe(
        'APPLY',
      );
    });

    it.each([
      'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN',
      'DEFERRED_WINDOW_CLOSED',
      'DEFERRED_HUMAN_SESSION',
    ])('refuses %s with OUTCOME_NOT_ALLOWED', (outcome) => {
      const input = body(outcome);
      expect(classifyOutcome(merged, input, hashFeedOutcome(input))).toBe(
        'OUTCOME_NOT_ALLOWED',
      );
    });

    it('does not turn a replay or a second terminal outcome into a 422', () => {
      const stale = body('STALE');
      const hash = hashFeedOutcome(stale);
      const acked = {
        ...merged,
        attemptId: ATTEMPT,
        evidenceHash: hash,
        ackedAt: new Date(AT),
      };
      expect(classifyOutcome(acked, stale, hash)).toBe('REPLAY');
      const other = parseFeedOutcome({
        attemptId: OTHER_ATTEMPT,
        outcome: 'STALE',
      });
      expect(classifyOutcome(acked, other, hashFeedOutcome(other))).toBe(
        'OUTCOME_ALREADY_RECORDED',
      );
    });

    it('leaves the other types as they were (answered accepts PROVIDER_ACCEPTED)', () => {
      const accepted = body('PROVIDER_ACCEPTED');
      expect(
        classifyOutcome(
          { ...merged, type: FEED_TYPE.answered },
          accepted,
          hashFeedOutcome(accepted),
        ),
      ).toBe('APPLY');
    });
  });
});
