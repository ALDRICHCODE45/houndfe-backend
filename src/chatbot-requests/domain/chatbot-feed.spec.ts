import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  buildAnswerPayload,
  buildCancelPayload,
  classifyOutcome,
  FEED_LIMITS,
  FEED_TYPE,
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

describe('request.answered payload (§3.3: kind, text, prefix + structured fields)', () => {
  it('tells a restock estimate with the days and the legacy id', () => {
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
    expect(none.text).toContain('Por ahora no tenemos una fecha estimada');
  });

  it('relays the staff expiration text with the team prefix', () => {
    const payload = buildAnswerPayload({
      subtype: 'EXPIRATION',
      legacyId: 'hd-2',
      productName: 'Leche',
      action: 'PROVIDE_EXPIRATION_TEXT',
      expirationText: 'Caduca en marzo 2027',
    });
    expect(payload).toMatchObject({
      action: 'PROVIDE_EXPIRATION_TEXT',
      text: 'Caduca en marzo 2027',
      prefix: TEAM_REPLY_PREFIX,
      expirationText: 'Caduca en marzo 2027',
    });
  });

  it('answers each delivery zone type with its fixed text and fields', () => {
    const base = {
      subtype: 'DELIVERY_ZONE' as const,
      legacyId: 'dzr-1',
      zipCode: '06600',
    };
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
      etaDays: 2,
      text: 'Sí entregamos en tu código postal (06600), sin costo de envío. Tiempo estimado: 2 días.',
    });
    const surcharge = buildAnswerPayload({
      ...base,
      zoneType: 'SURCHARGE',
      surchargeCents: 5000,
      etaDays: null,
    });
    expect(surcharge).toMatchObject({ surchargeCents: 5000 });
    expect(surcharge.text).toContain('$50.00 MXN');
    expect(
      buildAnswerPayload({
        ...base,
        zoneType: 'CARRIER_ONLY',
        surchargeCents: null,
        etaDays: null,
      }).text,
    ).toContain('solo por paquetería');
    expect(
      buildAnswerPayload({
        ...base,
        zoneType: 'DENIED',
        surchargeCents: null,
        etaDays: null,
      }),
    ).toMatchObject({
      action: 'REJECT_DELIVERY_ZONE',
      text: 'Por ahora no entregamos en tu código postal (06600).',
    });
  });

  it('carries the customerReason of a rejected receipt', () => {
    expect(
      buildAnswerPayload({
        subtype: 'TRANSFER_RECEIPT',
        legacyId: 'r-1',
        status: 'REJECTED',
        customerReason: 'La imagen no se ve',
      }),
    ).toMatchObject({
      action: 'REJECT_RECEIPT',
      customerReason: 'La imagen no se ve',
      text: 'La imagen no se ve',
      prefix: TEAM_REPLY_PREFIX,
    });
    expect(
      buildAnswerPayload({
        subtype: 'TRANSFER_RECEIPT',
        legacyId: 'r-1',
        status: 'CONFIRMED',
        customerReason: null,
      }),
    ).toMatchObject({ action: 'CONFIRM_RECEIPT', prefix: null });
  });

  it('falls back to a generic text when a rejection has no customerReason', () => {
    const payload = buildAnswerPayload({
      subtype: 'TRANSFER_RECEIPT',
      legacyId: 'r-1',
      status: 'REJECTED',
      customerReason: null,
    });
    expect(payload.text).toContain('No pudimos validar tu comprobante');
    expect(payload.prefix).toBeNull();
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
