import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { editorialAliasComparisonKeyV1 as key } from './editorial-alias-comparison-v1';
import { UNICODE17_CASE_FOLD } from './editorial-unicode17-case-fold.generated';

const whitespace = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

describe('collision-key-ucd17-v1 (dormant)', () => {
  it('retains exactly 1,585 immutable full C/F mappings and provenance', () => {
    expect(Object.keys(UNICODE17_CASE_FOLD)).toHaveLength(1585);
    expect(Object.isFrozen(UNICODE17_CASE_FOLD)).toBe(true);
    expect(UNICODE17_CASE_FOLD[0x1e9e]).toBe('ss'); // F, not S (ß).
    expect(UNICODE17_CASE_FOLD[0x49]).toBe('i'); // C, not Turkic T (ı).
    expect(UNICODE17_CASE_FOLD[0x130]).toBe('i\u0307');
    expect(UNICODE17_CASE_FOLD[0x1c89]).toBe('\u1c8a');
    const source = readFileSync(
      resolve(__dirname, 'editorial-unicode17-case-fold.generated.ts'),
      'utf8',
    );
    expect(source.match(/^ {2}0x/gm)).toHaveLength(1585);
    expect(source).toContain(
      'https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt',
    );
    expect(source).toContain(
      'ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183',
    );
    for (const [point, folded] of Object.entries(UNICODE17_CASE_FOLD)) {
      expect(key(String.fromCodePoint(Number(point)))).toBe(key(folded));
    }
  });

  it('rejects unpinned generator input offline before any write', () => {
    const script = resolve(
      __dirname,
      '../../../scripts/generate-editorial-unicode17-case-fold.mjs',
    );
    const probe = `import { generate } from ${JSON.stringify('file://' + script)};
      try { generate(Buffer.from('not the pinned UCD')); process.exitCode = 1; }
      catch (error) { if (!error.message.includes('SHA-256 mismatch')) throw error; }`;
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        timeout: 5000,
      }),
    ).not.toThrow();
  });
  it.each([
    ['café', 'cafe'],
    ['CAFE\u0301', 'cafe'],
    [' pez  ángel ', 'pez angel'],
    ['Straße ẞ', 'strasse ss'],
    ['ﬃ', 'ffi'],
    ['Σςσ', 'σσσ'],
    ['İIı', 'iiı'],
    ['Ꭰꭰ', 'ᎠᎠ'],
    ['\u{10400}\u{10428}', '\u{10428}\u{10428}'],
    ['\u{1c89}', '\u{1c8a}'],
    ['Ａ①²', 'ａ①²'],
    ['\u212b', 'a'],
    ['a\u0301\u034f\u20dd', 'a\u034f\u20dd'],
    ['a\u093e\u02c6', 'a\u093e\u02c6'],
    ['क\u093c', 'क'],
    ['\ufeff\u200b x \u200b\ufeff', '\ufeff\u200b x \u200b\ufeff'],
    ['🐕雪', '🐕雪'],
    ['', ''],
    ['\u0301', ''],
    [' \t\u0301\n', ''],
  ])('maps %j to literal %j without altering original', (input, expected) => {
    const original = input;
    expect(key(input)).toBe(expected);
    expect(input).toBe(original);
    expect(key(expected)).toBe(expected);
  });

  it.each(whitespace)('collapses White_Space U+%s', (point) => {
    const space = String.fromCodePoint(point);
    expect(key(`${space}A${space}${space}B${space}`)).toBe('a b');
    expect(key(space)).toBe('');
  });

  it.each([
    '\ud800',
    '\udfff',
    'x\ud800y',
    '\udfff\ud800',
    null,
    undefined,
    0,
    false,
    {},
    [],
    new String('café'),
  ])('rejects non-scalar strings/non-strings %p', (input) => {
    expect(() => key(input)).toThrow(TypeError);
  });

  it('never invokes submitted accessors or coercion', () => {
    const getter = jest.fn(() => 'café');
    const input = Object.defineProperty({}, 'value', {
      get: getter,
      enumerable: true,
    });
    expect(() => key(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('checks actual runtime at use before validation or normalization', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      'unicode',
    );
    expect(descriptor).toBeDefined();
    const normalize = jest.spyOn(String.prototype, 'normalize');
    try {
      Object.defineProperty(process.versions, 'unicode', {
        ...descriptor,
        value: '16.0',
      });
      for (const input of ['café', '\ud800', null]) {
        expect(() => key(input)).toThrow(
          'collision-key-ucd17-v1 requires Unicode 17.0',
        );
      }
      expect(normalize).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.versions, 'unicode', descriptor!);
      normalize.mockRestore();
    }
    expect(key('CAFÉ')).toBe('cafe');
  });
});
