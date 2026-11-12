/**
 * DOMAIN UNIT SPEC: the text of a clarification reply (human-intervention
 * unit 10; contract §3.8 `{text ≤ 1500}`, §6.1, §6.4). Staff typed it, so it is
 * untrusted text: control and bidi-override characters are dropped, it is never
 * interpreted as HTML (it is stored as typed and rendered as text), and its
 * length is counted in characters like WhatsApp does.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { REPLY_LIMITS, parseReplyText } from './clarification-reply';

describe('parseReplyText', () => {
  it('keeps the words, trims the ends and keeps line breaks', () => {
    expect(parseReplyText('  Hola,\n\tsí lo tenemos.  ')).toBe(
      'Hola,\n\tsí lo tenemos.',
    );
  });

  it('keeps markup as plain text: it is never interpreted', () => {
    expect(parseReplyText('<b>Sí</b> & <script>x</script>')).toBe(
      '<b>Sí</b> & <script>x</script>',
    );
  });

  it('removes control characters and bidi overrides', () => {
    // U+202E (override) and U+2066 (isolate) go; U+200E (LRM) is kept text.
    expect(parseReplyText('a\u0000b\u0007c\u200Ed\u202Ee\u2066f\u009Fg')).toBe(
      'abc\u200Edefg',
    );
  });

  it('accepts exactly the limit and refuses one more (characters, not UTF-16 units)', () => {
    expect(REPLY_LIMITS.textMax).toBe(1500);
    expect(Array.from(parseReplyText('a'.repeat(1500)))).toHaveLength(1500);
    // 1500 emoji are 3000 UTF-16 units: still within the limit.
    expect(Array.from(parseReplyText('😀'.repeat(1500)))).toHaveLength(1500);
    expect(() => parseReplyText('a'.repeat(1501))).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseReplyText('😀'.repeat(1501))).toThrow(
      InvalidArgumentError,
    );
  });

  it.each([
    [''],
    ['   '],
    ['\n\t '],
    ['\u0000\u202E'],
    [null],
    [undefined],
    [7],
  ])('refuses %p: a reply needs words', (value) => {
    expect(() => parseReplyText(value)).toThrow(InvalidArgumentError);
  });

  it('never echoes the text in the error', () => {
    const secret = 'x'.repeat(1501) + ' 5512345678';
    try {
      parseReplyText(secret);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as Error).message).not.toContain('5512345678');
      expect((error as InvalidArgumentError).code).toBe('VALIDATION_ERROR');
    }
  });
});
