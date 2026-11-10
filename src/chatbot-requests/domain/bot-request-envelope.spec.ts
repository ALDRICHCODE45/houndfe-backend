import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  botEnvelopeHash,
  isWrappedSubtype,
  parseBotEnvelope,
} from './bot-request-envelope';
import { BOT_SCOPE_LIST, BOT_SCOPES } from './bot-scopes';

const ID = '5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10';

const direct = (over: Record<string, unknown> = {}) => ({
  sourceRequestId: ID,
  subtype: 'UNKNOWN_QUESTION',
  customer: {
    phoneCountryCode: '52',
    phone: '5512345678',
    displayName: 'Juan',
  },
  conversationRef: 'wa:5215512345678',
  lastCustomerMessageAt: '2026-11-09T16:02:11Z',
  summary: '¿El shampoo X sirve para cachorros?',
  needs: 'Pregunta si es apto.',
  context: { cartRef: 'cart-1', productIds: ['p1'], quantity: 2 },
  dedupKey: 'UNKNOWN_QUESTION:product:7f3e',
  triggerWaMessageId: 'wamid.HBg1',
  detail: {},
  ...over,
});

const bad = (body: unknown) =>
  expect(() => parseBotEnvelope(body)).toThrow(InvalidArgumentError);

describe('parseBotEnvelope', () => {
  it('parses a full clarification envelope', () => {
    const envelope = parseBotEnvelope(direct());

    expect(envelope).toMatchObject({
      sourceRequestId: ID,
      subtype: 'UNKNOWN_QUESTION',
      customer: { phoneCountryCode: '52', phone: '5512345678' },
      conversationRef: 'wa:5215512345678',
      summary: '¿El shampoo X sirve para cachorros?',
      dedupKey: 'UNKNOWN_QUESTION:product:7f3e',
      scheduledFor: null,
    });
    expect(envelope.lastCustomerMessageAt?.toISOString()).toBe(
      '2026-11-09T16:02:11.000Z',
    );
  });

  it('accepts a wrapped subtype with only its detail', () => {
    const envelope = parseBotEnvelope({
      sourceRequestId: ID,
      subtype: 'RESTOCK',
      detail: { sourceRequestId: ID, type: 'RESTOCK' },
    });

    expect(envelope.customer).toBeNull();
    expect(envelope.summary).toBeNull();
    expect(envelope.detail).toEqual({ sourceRequestId: ID, type: 'RESTOCK' });
    expect(isWrappedSubtype(envelope.subtype)).toBe(true);
  });

  it('keeps scheduledFor so the service can refuse it until unit 14', () => {
    expect(
      parseBotEnvelope(direct({ scheduledFor: '2026-11-10T15:00:00Z' }))
        .scheduledFor,
    ).toEqual(new Date('2026-11-10T15:00:00Z'));
  });

  it.each([
    ['a non-object body', 'x'],
    ['an unknown key (tenantId)', direct({ tenantId: 't' })],
    ['a bad sourceRequestId', direct({ sourceRequestId: 'nope' })],
    ['an unknown subtype', direct({ subtype: 'LOL' })],
    ['a missing customer on a clarification', direct({ customer: undefined })],
    [
      'a phone with no canonical form',
      direct({ customer: { phoneCountryCode: '52', phone: '123' } }),
    ],
    ['a missing conversationRef', direct({ conversationRef: undefined })],
    ['a bad timestamp', direct({ lastCustomerMessageAt: 'yesterday' })],
    ['an empty summary', direct({ summary: '  ' })],
    ['a 141-char summary', direct({ summary: 'a'.repeat(141) })],
    ['a control character in summary', direct({ summary: 'a\u0007b' })],
    ['needs over 1000 chars', direct({ needs: 'n'.repeat(1001) })],
    ['a context key outside the allowlist', direct({ context: { price: 1 } })],
    ['a non-id context value', direct({ context: { cartRef: '<b>x</b>' } })],
    [
      'a dedupKey without a customer',
      {
        sourceRequestId: ID,
        subtype: 'RESTOCK',
        dedupKey: 'RESTOCK:variant:1',
        detail: {},
      },
    ],
    ['a dedupKey with spaces', direct({ dedupKey: 'a b' })],
    ['a detail on a clarification', direct({ detail: { a: 1 } })],
    [
      'a wrapped subtype without detail',
      {
        sourceRequestId: ID,
        subtype: 'EXPIRATION',
      },
    ],
    ['a scheduledFor that is not a date', direct({ scheduledFor: 'soon' })],
  ])('rejects %s', (_label, body) => bad(body));
});

describe('botEnvelopeHash', () => {
  it('ignores key order and display-only fields, and tracks real changes', () => {
    const a = parseBotEnvelope(direct());
    const reordered = parseBotEnvelope({
      ...direct(),
      context: { quantity: 2, productIds: ['p1'], cartRef: 'cart-1' },
      customer: {
        displayName: 'Otro',
        phone: '5512345678',
        phoneCountryCode: '52',
      },
    });
    const changed = parseBotEnvelope(direct({ summary: 'otra pregunta' }));

    expect(botEnvelopeHash(reordered)).toBe(botEnvelopeHash(a));
    expect(botEnvelopeHash(changed)).not.toBe(botEnvelopeHash(a));
  });
});

describe('bot scopes (§3.1)', () => {
  it('lists the seven scopes the new routes use', () => {
    expect([...BOT_SCOPE_LIST].sort()).toEqual(
      [
        'requests:create',
        'requests:read',
        'requests:cancel',
        'feed:read',
        'feed:ack',
        'conversation:write',
        'media:write',
      ].sort(),
    );
    expect(BOT_SCOPES.requestsCreate).toBe('requests:create');
  });
});
