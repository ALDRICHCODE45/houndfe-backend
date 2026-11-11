import { parseInboxSearch } from './inbox-search';

const WITH_PHONE = { canSearchPhone: true };
const NO_PHONE = { canSearchPhone: false };

describe('parseInboxSearch (§3.8 q)', () => {
  it('reads an exact folio, any case and any zero padding', () => {
    expect(parseInboxSearch('S-000123', WITH_PHONE)).toEqual({
      kind: 'folio',
      folio: 123,
    });
    expect(parseInboxSearch(' s-7 ', NO_PHONE)).toEqual({
      kind: 'folio',
      folio: 7,
    });
  });

  it('does not read a folio out of other text or an overflowing number', () => {
    expect(parseInboxSearch('S-12x', WITH_PHONE).kind).toBe('name');
    expect(parseInboxSearch('S-99999999999', WITH_PHONE).kind).toBe('name');
    expect(parseInboxSearch('S-0', WITH_PHONE).kind).toBe('name');
  });

  it('reads digits (with phone separators) as a phone search', () => {
    expect(parseInboxSearch('55 1234-5678', WITH_PHONE)).toEqual({
      kind: 'phone',
      digits: '5512345678',
    });
    expect(parseInboxSearch('+52 (55) 1234', WITH_PHONE)).toEqual({
      kind: 'phone',
      digits: '52551234',
    });
  });

  it('searches nothing for a digits-only q without read:CustomerPhone', () => {
    expect(parseInboxSearch('5512345678', NO_PHONE)).toEqual({ kind: 'none' });
    expect(parseInboxSearch('5678', NO_PHONE)).toEqual({ kind: 'none' });
    // not even by name: a number is never a name, so the endpoint is no oracle
    expect(parseInboxSearch('+52 55', NO_PHONE)).toEqual({ kind: 'none' });
  });

  it('never matches a phone from text that mixes letters and digits', () => {
    expect(parseInboxSearch('juan 5512', WITH_PHONE)).toEqual({
      kind: 'name',
      tokens: ['juan', '5512'],
    });
  });

  it('folds case and accents and splits on spaces', () => {
    expect(parseInboxSearch('  María  PÉREZ ', NO_PHONE)).toEqual({
      kind: 'name',
      tokens: ['maria', 'perez'],
    });
    expect(parseInboxSearch('Ñandú', NO_PHONE)).toEqual({
      kind: 'name',
      tokens: ['nandu'],
    });
  });

  it('escapes LIKE wildcards so q cannot widen the match', () => {
    expect(parseInboxSearch('100%_a\\b', NO_PHONE)).toEqual({
      kind: 'name',
      tokens: ['100\\%\\_a\\\\b'],
    });
  });

  it('caps the tokens and ignores an empty q', () => {
    const result = parseInboxSearch('a b c d e f g', NO_PHONE);
    expect(result.kind === 'name' && result.tokens).toHaveLength(4);
    expect(parseInboxSearch('   ', WITH_PHONE)).toEqual({ kind: 'absent' });
    expect(parseInboxSearch(undefined, WITH_PHONE)).toEqual({ kind: 'absent' });
  });
});
