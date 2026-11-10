import { canonicalPhone } from './canonical-phone';

describe('canonicalPhone (R1)', () => {
  it.each([
    ['10-digit national number', '52', '5512345678'],
    ['WhatsApp wa_id 521 + 10 digits', '52', '5215512345678'],
    ['52 + 10 digits', '52', '525512345678'],
    ['11-digit national number with the mobile 1', '52', '15512345678'],
    ['formatted input', '+52', '+52 1 (55) 1234-5678'],
    ['dotted input', '52', '55.1234.5678'],
  ])('reduces %s to the Mexican customerKey', (_case, cc, phone) => {
    expect(canonicalPhone(cc, phone)).toBe('525512345678');
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
  ])('rejects %s', (_case, cc, phone) => {
    expect(canonicalPhone(cc, phone)).toBeNull();
  });

  it('rejects non-string input without throwing', () => {
    expect(canonicalPhone(52 as unknown as string, '5512345678')).toBeNull();
    expect(canonicalPhone('52', null as unknown as string)).toBeNull();
  });
});
