/**
 * Unit 10: how the bot attributes a mirrored message to a staff clarification
 * reply. The author is still never sent by the bot (`STAFF` stays refused);
 * the only link is `staffReplyId`, the `replyId` of the `request.answered`
 * item, valid on an outgoing TEXT message. The backend decides the author and
 * the staff user from its own reply record, never from the batch.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { parseMessageBatch } from './conversation-message';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const REPLY_ID = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';

const out = (over: Record<string, unknown> = {}) => ({
  waMessageId: 'wamid.reply1',
  direction: 'OUT',
  type: 'TEXT',
  text: 'Le comparto la respuesta del equipo: Sí, es apto.',
  providerTimestamp: '2026-11-12T11:59:00.000Z',
  observedAt: '2026-11-12T11:59:01.000Z',
  ...over,
});
const parse = (message: Record<string, unknown>) =>
  parseMessageBatch({ messages: [message] }, NOW);

describe('staffReplyId on a mirrored message', () => {
  it('is accepted on an outgoing TEXT and kept; the author stays BOT until the store attributes it', () => {
    const [parsed] = parse(out({ staffReplyId: REPLY_ID }));
    expect(parsed).toMatchObject({
      author: 'BOT',
      direction: 'OUT',
      staffReplyId: REPLY_ID,
    });
  });

  it('is null when absent', () => {
    expect(parse(out())[0].staffReplyId).toBeNull();
  });

  it('lets the reply id be written in upper case (normalised to lower case)', () => {
    expect(
      parse(out({ staffReplyId: REPLY_ID.toUpperCase() }))[0].staffReplyId,
    ).toBe(REPLY_ID);
  });

  it.each([
    ['an incoming message', out({ direction: 'IN', staffReplyId: REPLY_ID })],
    [
      'a non-TEXT message',
      out({
        type: 'IMAGE',
        mediaId: '0b3f1c1e-2f5a-4a8b-9d0e-6f1a2b3c4d5e',
        staffReplyId: REPLY_ID,
      }),
    ],
    ['a malformed id', out({ staffReplyId: 'not-a-uuid' })],
    ['a non-string id', out({ staffReplyId: 7 })],
    ['null', out({ staffReplyId: null })],
  ])('is refused on %s', (_name, message) => {
    expect(() => parse(message)).toThrow(InvalidArgumentError);
  });

  it('does not open the door to author STAFF or a staff user', () => {
    expect(() =>
      parse(out({ staffReplyId: REPLY_ID, author: 'STAFF' })),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      parse(out({ staffReplyId: REPLY_ID, staffUserId: 'u-ana' })),
    ).toThrow(InvalidArgumentError);
  });

  it('the same reply id twice in one batch is refused', () => {
    expect(() =>
      parseMessageBatch(
        {
          messages: [
            out({ staffReplyId: REPLY_ID }),
            out({ waMessageId: 'wamid.reply2', staffReplyId: REPLY_ID }),
          ],
        },
        NOW,
      ),
    ).toThrow(InvalidArgumentError);
  });
});
