/**
 * R1 (contract §3.7, §10.1): the one function that turns the bot's
 * `{phoneCountryCode, phone}` into `customerKey`, the E.164 digits without the
 * leading `+` (`525512345678`). Every new intake and lookup uses it.
 *
 * - Mexico (`52`): the national number is 10 digits not starting with 0 or 1.
 *   WhatsApp's `521…` mobile form, an `11`-digit number starting with `1`, and
 *   a number that repeats the country code all reduce to those 10 digits. A
 *   country code of `521` or `+521` counts as `52`.
 * - NANP (`1`): the same 10-digit rule; a leading `1` is the country code
 *   repeated.
 * - Other countries: the digits as given, within E.164's 15-digit limit.
 *
 * Returns `null` for anything else (letters, wrong length, bad country code),
 * so intake answers `400 VALIDATION_ERROR` instead of grouping by junk.
 */
const SEPARATORS = /^[\d\s+().-]*$/;
/** NANP-style national number: 10 digits, never starting with 0 or 1. */
const NANP_NATIONAL = /^[2-9]\d{9}$/;

function nationalDigits(cc: string, digits: string): string | null {
  if (cc === '52') {
    const national =
      digits.length === 13 && digits.startsWith('521')
        ? digits.slice(3)
        : digits.length === 12 && digits.startsWith('52')
          ? digits.slice(2)
          : digits.length === 11 && digits.startsWith('1')
            ? digits.slice(1)
            : digits;
    return NANP_NATIONAL.test(national) ? national : null;
  }
  if (cc === '1') {
    const national =
      digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    return NANP_NATIONAL.test(national) ? national : null;
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
  const digits = countryCode.replace(/\D/g, '');
  // `521` is WhatsApp's Mexican mobile prefix, not a country code of its own.
  const cc = digits === '521' ? '52' : digits;
  if (!/^[1-9]\d{0,2}$/.test(cc)) return null;
  const national = nationalDigits(cc, phone.replace(/\D/g, ''));
  if (!national) return null;
  const key = cc + national;
  return key.length >= 8 && key.length <= 15 ? key : null;
}

/**
 * The `(phoneCountryCode, phone)` pairs a stored `Customer` can hold for one
 * canonical key. `Customer` stores digits as typed, so `52` + `5512345678` and
 * `521` + `5512345678` are the same person. The result feeds an indexed
 * `IN (…)` lookup (`customers (tenantId, phoneCountryCode, phone)`); callers
 * still compare `canonicalPhone` of each hit, so a loose variant never links a
 * different number. Empty when the input has no canonical form.
 */
export function phoneLookupVariants(
  countryCode: string,
  phone: string,
): { countryCodes: string[]; phones: string[] } {
  const key = canonicalPhone(countryCode, phone);
  if (!key) return { countryCodes: [], phones: [] };
  const digits = countryCode.replace(/\D/g, '');
  const cc = digits === '521' ? '52' : digits;
  const national = key.slice(cc.length);
  const countryCodes = cc === '52' ? ['52', '521'] : [cc];
  const phones =
    cc === '52'
      ? [national, `1${national}`, `52${national}`, `521${national}`]
      : cc === '1'
        ? [national, `1${national}`]
        : [national];
  return { countryCodes, phones };
}

/** Whether a stored `Customer` phone is the canonical `customerKey` (R1). */
export function customerHasKey(
  customer: { phoneCountryCode: string | null; phone: string | null },
  customerKey: string,
): boolean {
  return (
    customer.phoneCountryCode !== null &&
    customer.phone !== null &&
    canonicalPhone(customer.phoneCountryCode, customer.phone) === customerKey
  );
}
