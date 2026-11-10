import { canonicalPhone, phoneLookupVariants } from './canonical-phone';

describe('canonicalPhone (R1)', () => {
  it.each([
    ['10-digit national number', '52', '5512345678'],
    ['WhatsApp wa_id 521 + 10 digits', '52', '5215512345678'],
    ['52 + 10 digits', '52', '525512345678'],
    ['11-digit national number with the mobile 1', '52', '15512345678'],
    ['formatted input', '+52', '+52 1 (55) 1234-5678'],
    ['dotted input', '52', '55.1234.5678'],
    ['country code 521 with 10 digits', '521', '5512345678'],
    ['country code +521 with 10 digits', '+521', '5512345678'],
    ['country code 521 with the wa_id', '521', '5215512345678'],
  ])('reduces %s to the Mexican customerKey', (_case, cc, phone) => {
    expect(canonicalPhone(cc, phone)).toBe('525512345678');
  });

  it('gives the same key for 521 and 52 country codes', () => {
    expect(canonicalPhone('521', '5512345678')).toBe(
      canonicalPhone('52', '5512345678'),
    );
  });

  it('keeps a 10-digit Mexican number that starts with 52', () => {
    expect(canonicalPhone('52', '5223456789')).toBe('525223456789');
  });

  it('keeps other countries as country code + national digits', () => {
    expect(canonicalPhone('1', '(415) 555-0123')).toBe('14155550123');
    expect(canonicalPhone('1', '14155550123')).toBe('14155550123');
    expect(canonicalPhone('34', '612 345 678')).toBe('34612345678');
  });

  it.each([
    ['empty phone', '52', ''],
    ['empty country code', '', '5512345678'],
    ['letters', '52', '55-1234-ABCD'],
    ['letters mixed into digits', '52', '55a12345678'],
    ['short Mexican number', '52', '551234567'],
    ['long Mexican number', '52', '55123456789012'],
    ['11 digits not starting with 1', '52', '25512345678'],
    ['country code with a leading zero', '052', '5512345678'],
    ['country code longer than 3 digits', '5212', '5512345678'],
    ['country code with letters', 'MX', '5512345678'],
    ['more than 15 digits', '1', '1234567890123456'],
    ['too short for E.164', '1', '12345'],
    ['521 + 9 digits', '52', '521551234567'],
    ['country code 521 with 9 digits', '521', '551234567'],
    ['Mexican national number starting with 0', '52', '0512345678'],
    [
      'Mexican national number starting with 1 after the mobile 1',
      '52',
      '11512345678',
    ],
    ['Mexican 10 digits starting with 1', '52', '1512345678'],
    ['NANP number starting with 0', '1', '0155550123'],
    ['NANP number starting with 1', '1', '1155550123'],
    ['NANP 11 digits starting with 11', '1', '11155550123'],
  ])('rejects %s', (_case, cc, phone) => {
    expect(canonicalPhone(cc, phone)).toBeNull();
  });

  it('rejects non-string input without throwing', () => {
    expect(canonicalPhone(52 as unknown as string, '5512345678')).toBeNull();
    expect(canonicalPhone('52', null as unknown as string)).toBeNull();
  });
});

describe('phoneLookupVariants (R1: stored customer phones)', () => {
  it('covers every stored form of a Mexican mobile number', () => {
    const { countryCodes, phones } = phoneLookupVariants('52', '5215512345678');
    expect(countryCodes.sort()).toEqual(['52', '521']);
    expect(phones.sort()).toEqual(
      ['15512345678', '5215512345678', '5512345678', '525512345678'].sort(),
    );
  });

  it('keeps one form for other countries and for NANP', () => {
    expect(phoneLookupVariants('57', '3001234567')).toEqual({
      countryCodes: ['57'],
      phones: ['3001234567'],
    });
    expect(phoneLookupVariants('1', '15555550123').phones.sort()).toEqual([
      '15555550123',
      '5555550123',
    ]);
  });

  it('is empty when the phone has no canonical form', () => {
    expect(phoneLookupVariants('52', 'abc')).toEqual({
      countryCodes: [],
      phones: [],
    });
  });
});
