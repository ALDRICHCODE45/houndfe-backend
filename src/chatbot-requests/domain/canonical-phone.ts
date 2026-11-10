/**
 * R1 (contract §3.7, §10.1): the one function that turns the bot's
 * `{phoneCountryCode, phone}` into `customerKey`, the E.164 digits without the
 * leading `+` (`525512345678`). Every new intake and lookup uses it.
 *
 * - Mexico (`52`): the national number is 10 digits. WhatsApp's `521…` mobile
 *   form, an `11`-digit national number starting with `1`, and a number that
 *   repeats the country code all reduce to those 10 digits.
 * - NANP (`1`): 10 digits; a leading `1` is the country code repeated.
 * - Other countries: the digits as given, within E.164's 15-digit limit.
 *
 * Returns `null` for anything else (letters, wrong length, bad country code),
 * so intake answers `400 VALIDATION_ERROR` instead of grouping by junk.
 */
const SEPARATORS = /^[\d\s+().-]*$/;

function nationalDigits(cc: string, digits: string): string | null {
  if (cc === '52') {
    if (digits.length === 13 && digits.startsWith('521'))
      return digits.slice(3);
    if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits.length === 10 ? digits : null;
  }
  if (cc === '1') {
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits.length === 10 ? digits : null;
  }
  return digits;
}

export function canonicalPhone(
  countryCode: string,
  phone: string,
): string | null {
  if (typeof countryCode !== 'string' || typeof phone !== 'string') {
    return null;
  }
  if (!SEPARATORS.test(countryCode) || !SEPARATORS.test(phone)) return null;
  const cc = countryCode.replace(/\D/g, '');
  if (!/^[1-9]\d{0,2}$/.test(cc)) return null;
  const national = nationalDigits(cc, phone.replace(/\D/g, ''));
  if (!national) return null;
  const key = cc + national;
  return key.length >= 8 && key.length <= 15 ? key : null;
}
