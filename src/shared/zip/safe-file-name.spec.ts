import {
  createFileNameAllocator,
  disambiguateFileNames,
  sanitizeFileNameBase,
  toSafeFileName,
} from './safe-file-name';

describe('sanitizeFileNameBase', () => {
  it('keeps accents, ñ and ordinary punctuation', () => {
    expect(sanitizeFileNameBase('Ana López')).toBe('Ana López');
    expect(sanitizeFileNameBase('Muñoz & Hijos, S.A. de C.V.')).toBe(
      'Muñoz & Hijos, S.A. de C.V',
    );
    expect(sanitizeFileNameBase("O'Brien (Matriz)")).toBe("O'Brien (Matriz)");
  });

  it('normalizes to NFC', () => {
    expect(sanitizeFileNameBase('Lo\u0301pez')).toBe('L\u00f3pez');
  });

  it('replaces characters invalid on Windows/macOS/Linux with "-"', () => {
    expect(sanitizeFileNameBase('a/b\\c:d*e?f"g<h>i|j')).toBe(
      'a-b-c-d-e-f-g-h-i-j',
    );
  });

  it('removes control, bidi and zero-width characters', () => {
    expect(sanitizeFileNameBase('Ana\u0000\u0007\tLópez\n')).toBe('Ana López');
    expect(sanitizeFileNameBase('Ana\u202eLópez\u200b\ufeff\u2066')).toBe(
      'AnaLópez',
    );
  });

  it('collapses whitespace and trims leading/trailing dots and spaces', () => {
    expect(sanitizeFileNameBase('   Ana    López ...  ')).toBe('Ana López');
    expect(sanitizeFileNameBase('..hidden')).toBe('hidden');
  });

  it('suffixes Windows reserved device names (case-insensitive, with or without extension-like dots)', () => {
    expect(sanitizeFileNameBase('CON')).toBe('CON_');
    expect(sanitizeFileNameBase('nul')).toBe('nul_');
    expect(sanitizeFileNameBase('Com1')).toBe('Com1_');
    expect(sanitizeFileNameBase('LPT9')).toBe('LPT9_');
    expect(sanitizeFileNameBase('aux.txt')).toBe('aux_.txt');
    expect(sanitizeFileNameBase('Conrado')).toBe('Conrado');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(sanitizeFileNameBase('')).toBe('');
    expect(sanitizeFileNameBase('  ... ')).toBe('');
    expect(sanitizeFileNameBase('\u0000\u0001')).toBe('');
  });

  it('caps the length in characters without splitting surrogate pairs, then re-trims', () => {
    expect(sanitizeFileNameBase('a'.repeat(300))).toHaveLength(100);
    expect(sanitizeFileNameBase('ñ'.repeat(300), { maxLength: 10 })).toBe(
      'ñ'.repeat(10),
    );
    const emoji = '😀'.repeat(5);
    expect(sanitizeFileNameBase(emoji, { maxLength: 3 })).toBe('😀😀😀');
    expect(sanitizeFileNameBase('abc. def', { maxLength: 5 })).toBe('abc');
  });
});

describe('toSafeFileName', () => {
  it('appends the extension to the sanitized name', () => {
    expect(
      toSafeFileName('Ana López', { fallback: 'id-1', extension: '.pdf' }),
    ).toBe('Ana López.pdf');
  });

  it('falls back to the sanitized fallback when the name is empty, null or unusable', () => {
    expect(
      toSafeFileName('', { fallback: '3f2a9c1e', extension: '.pdf' }),
    ).toBe('3f2a9c1e.pdf');
    expect(
      toSafeFileName(null, { fallback: '3f2a9c1e', extension: '.pdf' }),
    ).toBe('3f2a9c1e.pdf');
    expect(
      toSafeFileName(undefined, { fallback: '3f2a9c1e', extension: '.pdf' }),
    ).toBe('3f2a9c1e.pdf');
    expect(
      toSafeFileName(' ... ', { fallback: '3f2a9c1e', extension: '.pdf' }),
    ).toBe('3f2a9c1e.pdf');
  });

  it('throws when both name and fallback are unusable', () => {
    expect(() =>
      toSafeFileName('', { fallback: ' / ', extension: '.pdf' }),
    ).not.toThrow();
    expect(() =>
      toSafeFileName('', { fallback: '...', extension: '.pdf' }),
    ).toThrow(/fallback/i);
  });

  it('accepts an extension without a leading dot and an empty extension', () => {
    expect(toSafeFileName('Ana', { fallback: 'x', extension: 'pdf' })).toBe(
      'Ana.pdf',
    );
    expect(toSafeFileName('Ana', { fallback: 'x', extension: '' })).toBe('Ana');
  });
});

describe('disambiguateFileNames', () => {
  it('keeps unique names and numbers duplicates deterministically in input order', () => {
    expect(
      disambiguateFileNames(
        [
          { name: 'Ana López', fallback: 'a' },
          { name: 'Beto', fallback: 'b' },
          { name: 'Ana López', fallback: 'c' },
          { name: 'Ana López', fallback: 'd' },
        ],
        '.pdf',
      ),
    ).toEqual([
      'Ana López.pdf',
      'Beto.pdf',
      'Ana López (2).pdf',
      'Ana López (3).pdf',
    ]);
  });

  it('detects collisions case-insensitively and after sanitization/normalization', () => {
    expect(
      disambiguateFileNames(
        [
          { name: 'Ana López', fallback: 'a' },
          { name: 'ANA LÓPEZ', fallback: 'b' },
          { name: ' ana  lópez. ', fallback: 'c' },
          { name: 'Ana López', fallback: 'd' },
        ],
        '.pdf',
      ),
    ).toEqual([
      'Ana López.pdf',
      'ANA LÓPEZ (2).pdf',
      'ana lópez (3).pdf',
      'Ana López (4).pdf',
    ]);
  });

  it('skips a suffix already taken by a real name', () => {
    expect(
      disambiguateFileNames(
        [
          { name: 'Ana (2)', fallback: 'a' },
          { name: 'Ana', fallback: 'b' },
          { name: 'Ana', fallback: 'c' },
        ],
        '.pdf',
      ),
    ).toEqual(['Ana (2).pdf', 'Ana.pdf', 'Ana (3).pdf']);
  });

  it('disambiguates fallbacks too', () => {
    expect(
      disambiguateFileNames(
        [
          { name: '', fallback: 'same' },
          { name: null, fallback: 'same' },
        ],
        '.pdf',
      ),
    ).toEqual(['same.pdf', 'same (2).pdf']);
  });

  it('keeps the suffix within the length cap', () => {
    const long = 'x'.repeat(200);
    const [first, second] = disambiguateFileNames(
      [
        { name: long, fallback: 'a' },
        { name: long, fallback: 'b' },
      ],
      '.pdf',
      { maxLength: 20 },
    );
    expect(first).toBe(`${'x'.repeat(20)}.pdf`);
    expect(second).toBe(`${'x'.repeat(16)} (2).pdf`);
  });
});

describe('createFileNameAllocator', () => {
  it('allocates incrementally with the same rules as disambiguateFileNames', () => {
    const allocator = createFileNameAllocator({ extension: '.pdf' });
    expect(allocator.allocate('Ana', 'a')).toBe('Ana.pdf');
    expect(allocator.allocate('ana', 'b')).toBe('ana (2).pdf');
    expect(allocator.allocate(null, 'c')).toBe('c.pdf');
  });
});
