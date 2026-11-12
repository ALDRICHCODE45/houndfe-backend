import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  CONVERSATION_LIMITS,
  MessageBatchTooLargeError,
  customerKeyFromConversationRef,
  parseConversationRef,
  parseMessageBatch,
  parseStatusBatch,
  sanitizeMessageText,
} from './conversation-message';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const MEDIA = '0b3f1c1e-2f5a-4a8b-9d0e-6f1a2b3c4d5e';

const message = (over: Record<string, unknown> = {}) => ({
  waMessageId: 'wamid.HBgMNTIxNTUxMjM0NTY3OA==',
  direction: 'IN',
  type: 'TEXT',
  text: 'Hola, ¿tienen croquetas?',
  providerTimestamp: '2026-11-12T11:59:00.000Z',
  observedAt: '2026-11-12T11:59:01.000Z',
  ...over,
});
const batch = (...messages: Record<string, unknown>[]) => ({ messages });
const parse = (body: unknown) => parseMessageBatch(body, NOW);

describe('parseConversationRef', () => {
  it.each(['wa:5215512345678', 'wa:5215512345678'.toUpperCase().toLowerCase()])(
    'accepts %s',
    (ref) => expect(parseConversationRef(ref)).toBe(ref),
  );

  it.each([
    '',
    'x'.repeat(201),
    'wa:55 1234',
    'wa:5215512345678\n',
    'wa:<script>',
    undefined,
    42,
  ])('rejects %p', (ref) => {
    expect(() => parseConversationRef(ref)).toThrow(InvalidArgumentError);
  });
});

describe('customerKeyFromConversationRef (R1)', () => {
  it.each([
    ['wa:5215512345678', '525512345678'],
    ['wa:525512345678', '525512345678'],
    ['wa:15551234567', '15551234567'],
    ['wa:447911123456', '447911123456'],
  ])('%s -> %s', (ref, key) => {
    expect(customerKeyFromConversationRef(ref)).toBe(key);
  });

  it('is null for a reference that is not a wa_id', () => {
    expect(customerKeyFromConversationRef('conv-17')).toBeNull();
  });
});

describe('sanitizeMessageText', () => {
  it('keeps newlines, tabs and ordinary text', () => {
    expect(sanitizeMessageText('a\nb\tc  ñ 😀')).toBe('a\nb\tc  ñ 😀');
  });

  it('drops NUL, other C0/C1 controls and bidi overrides', () => {
    expect(sanitizeMessageText('a\u0000b\u0007c‮d⁦e\u0085f')).toBe('abcdef');
  });

  it('does not touch markup: the frontend renders text, never HTML', () => {
    expect(sanitizeMessageText('<b>hola</b> & más')).toBe('<b>hola</b> & más');
  });
});

describe('parseMessageBatch', () => {
  it('maps a customer text to author CUSTOMER and a bot text to BOT', () => {
    const parsed = parse(
      batch(
        message(),
        message({ waMessageId: 'wamid.2', direction: 'OUT', text: 'Claro' }),
      ),
    );
    expect(parsed.map((m) => [m.direction, m.author, m.type])).toEqual([
      ['IN', 'CUSTOMER', 'TEXT'],
      ['OUT', 'BOT', 'TEXT'],
    ]);
    expect(parsed[0].providerTimestamp.toISOString()).toBe(
      '2026-11-12T11:59:00.000Z',
    );
  });

  it('keeps the order of the array (the backend assigns seq in that order)', () => {
    const ids = ['wamid.c', 'wamid.a', 'wamid.b'];
    const parsed = parse(
      batch(...ids.map((waMessageId) => message({ waMessageId }))),
    );
    expect(parsed.map((m) => m.waMessageId)).toEqual(ids);
  });

  it('accepts the declared author when it matches the direction', () => {
    expect(() => parse(batch(message({ author: 'CUSTOMER' })))).not.toThrow();
    expect(() =>
      parse(batch(message({ direction: 'OUT', author: 'BOT' }))),
    ).not.toThrow();
  });

  it.each([
    ['STAFF on OUT', { direction: 'OUT', author: 'STAFF' }],
    ['SYSTEM on OUT', { direction: 'OUT', author: 'SYSTEM' }],
    ['BOT on IN', { direction: 'IN', author: 'BOT' }],
    ['CUSTOMER on OUT', { direction: 'OUT', author: 'CUSTOMER' }],
    ['unknown author', { author: 'ADMIN' }],
  ])(
    'rejects %s: the bot cannot write staff or system messages (§4.1)',
    (_n, over) => {
      expect(() => parse(batch(message(over)))).toThrow(InvalidArgumentError);
    },
  );

  it('rejects the SYSTEM type (backend timeline marks only)', () => {
    expect(() => parse(batch(message({ type: 'SYSTEM' })))).toThrow(
      InvalidArgumentError,
    );
  });

  it('413 over 50 messages, typed so the service can answer BATCH_TOO_LARGE', () => {
    const many = Array.from(
      { length: CONVERSATION_LIMITS.batchMax + 1 },
      (_, i) => message({ waMessageId: `wamid.${i}` }),
    );
    expect(() => parse(batch(...many))).toThrow(MessageBatchTooLargeError);
    expect(() => parse(batch(...many.slice(0, 50)))).not.toThrow();
  });

  it.each([
    ['not an object', 'x'],
    ['no messages key', {}],
    ['empty batch', { messages: [] }],
    ['messages not an array', { messages: {} }],
    ['unknown top-level key', { messages: [message()], tenantId: 't' }],
  ])('400 on %s', (_n, body) => {
    expect(() => parse(body)).toThrow(InvalidArgumentError);
  });

  it('400 on unknown message keys (tenant, credential, seq never come from the bot)', () => {
    for (const key of [
      'tenantId',
      'seq',
      'staffUserId',
      'deliveryStatus',
      'purgeAfter',
    ]) {
      expect(() => parse(batch(message({ [key]: 'x' })))).toThrow(
        InvalidArgumentError,
      );
    }
  });

  it('400 on a duplicated waMessageId inside one batch', () => {
    expect(() => parse(batch(message(), message()))).toThrow(
      InvalidArgumentError,
    );
  });

  it.each([
    ['empty id', { waMessageId: '' }],
    ['long id', { waMessageId: 'w'.repeat(256) }],
    ['id with spaces', { waMessageId: 'wamid x' }],
    ['bad direction', { direction: 'SIDEWAYS' }],
    ['bad type', { type: 'VIDEO' }],
    ['missing timestamp', { providerTimestamp: undefined }],
    ['bad timestamp', { providerTimestamp: 'yesterday' }],
    ['timestamp without zone', { observedAt: '2026-11-12T11:59:00' }],
    ['timestamp from 1999', { providerTimestamp: '1999-01-01T00:00:00Z' }],
    [
      'timestamp too far in the future',
      { providerTimestamp: '2026-11-12T12:10:00Z' },
    ],
    ['empty TEXT', { text: '   ' }],
    ['TEXT with no text', { text: undefined }],
    ['text with only controls', { text: '\u0000\u0007' }],
    ['text over 4096 characters', { text: 'a'.repeat(4097) }],
    ['text not a string', { text: 12 }],
    ['mediaId on TEXT', { mediaId: MEDIA }],
  ])('400 on %s', (_n, over) => {
    expect(() => parse(batch(message(over)))).toThrow(InvalidArgumentError);
  });

  it('counts the 4096 limit in characters, not UTF-16 units', () => {
    expect(() =>
      parse(batch(message({ text: '😀'.repeat(4096) }))),
    ).not.toThrow();
    expect(() => parse(batch(message({ text: '😀'.repeat(4097) })))).toThrow(
      InvalidArgumentError,
    );
  });

  it('allows a timestamp up to 5 minutes ahead (bot clock skew)', () => {
    expect(() =>
      parse(batch(message({ providerTimestamp: '2026-11-12T12:05:00.000Z' }))),
    ).not.toThrow();
  });

  it('sanitizes the stored text', () => {
    const [m] = parse(batch(message({ text: 'hola\u0000‮ mundo' })));
    expect(m.text).toBe('hola mundo');
  });

  it.each(['IMAGE', 'STICKER', 'DOCUMENT', 'AUDIO'])(
    '%s needs a mediaId (uuid) and may carry a caption',
    (type) => {
      const [m] = parse(batch(message({ type, mediaId: MEDIA, text: 'pie' })));
      expect(m.mediaId).toBe(MEDIA);
      expect(m.text).toBe('pie');
      expect(() => parse(batch(message({ type, text: undefined })))).toThrow(
        InvalidArgumentError,
      );
      expect(() =>
        parse(batch(message({ type, mediaId: 'not-a-uuid' }))),
      ).toThrow(InvalidArgumentError);
    },
  );

  it('a media message may have no text at all', () => {
    const [m] = parse(
      batch(message({ type: 'AUDIO', mediaId: MEDIA, text: undefined })),
    );
    expect(m.text).toBeNull();
  });

  it('UNSUPPORTED gets a fixed backend text and takes no text or media', () => {
    const [video] = parse(
      batch(message({ type: 'UNSUPPORTED', kind: 'VIDEO', text: undefined })),
    );
    expect(video.text).toBe('Video recibido');
    const [location] = parse(
      batch(
        message({ type: 'UNSUPPORTED', kind: 'LOCATION', text: undefined }),
      ),
    );
    expect(location.text).toBe('Ubicación recibida');
    const [other] = parse(
      batch(message({ type: 'UNSUPPORTED', text: undefined })),
    );
    expect(other.text).toBe('Mensaje no compatible recibido');
    expect(() =>
      parse(batch(message({ type: 'UNSUPPORTED', text: 'customer words' }))),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      parse(
        batch(
          message({ type: 'UNSUPPORTED', text: undefined, mediaId: MEDIA }),
        ),
      ),
    ).toThrow(InvalidArgumentError);
    expect(() => parse(batch(message({ kind: 'VIDEO' })))).toThrow(
      InvalidArgumentError,
    );
  });

  it('TEMPLATE is only an outgoing bot message', () => {
    expect(() =>
      parse(
        batch(message({ direction: 'OUT', type: 'TEMPLATE', text: 'Hola' })),
      ),
    ).not.toThrow();
    expect(() =>
      parse(batch(message({ direction: 'IN', type: 'TEMPLATE' }))),
    ).toThrow(InvalidArgumentError);
  });

  it('never echoes the input in the error', () => {
    try {
      parse(batch(message({ text: 'secret text '.repeat(500) })));
      fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});

describe('parseStatusBatch', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    providerMessageId: 'wamid.out-1',
    status: 'DELIVERED',
    occurredAt: '2026-11-12T11:59:30.000Z',
    ...over,
  });

  it('parses a status list', () => {
    expect(
      parseStatusBatch(
        { statuses: [status(), status({ status: 'READ' })] },
        NOW,
      ),
    ).toEqual([
      { providerMessageId: 'wamid.out-1', status: 'DELIVERED' },
      { providerMessageId: 'wamid.out-1', status: 'READ' },
    ]);
  });

  it('accepts an errorCode and drops it (nothing stores it)', () => {
    expect(
      parseStatusBatch(
        { statuses: [status({ status: 'FAILED', errorCode: '131047' })] },
        NOW,
      ),
    ).toEqual([{ providerMessageId: 'wamid.out-1', status: 'FAILED' }]);
  });

  it.each([
    ['QUEUED (backend-owned)', { status: 'QUEUED' }],
    ['DEFERRED (backend-owned)', { status: 'DEFERRED' }],
    ['UNKNOWN (backend-owned)', { status: 'UNKNOWN' }],
    ['bad status', { status: 'seen' }],
    ['bad id', { providerMessageId: '' }],
    ['bad occurredAt', { occurredAt: 'x' }],
    ['unknown key', { seq: 1 }],
    ['long errorCode', { errorCode: 'x'.repeat(65) }],
  ])('400 on %s', (_n, over) => {
    expect(() => parseStatusBatch({ statuses: [status(over)] }, NOW)).toThrow(
      InvalidArgumentError,
    );
  });

  it('413 over the batch cap, 400 on empty', () => {
    const many = Array.from(
      { length: CONVERSATION_LIMITS.statusBatchMax + 1 },
      (_, i) => status({ providerMessageId: `wamid.${i}` }),
    );
    expect(() => parseStatusBatch({ statuses: many }, NOW)).toThrow(
      MessageBatchTooLargeError,
    );
    expect(() => parseStatusBatch({ statuses: [] }, NOW)).toThrow(
      InvalidArgumentError,
    );
  });
});
