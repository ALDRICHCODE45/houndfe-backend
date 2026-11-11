/**
 * R12 (contract §3.8, §6.3, D11): the ONE serializer of a customer's phone in
 * every staff response of this module. A caller without `read:CustomerPhone`
 * gets the area code and the last four digits (`55 **** 5678`); with it, the
 * full E.164 number (`+525512345678`). The frontend shows what it receives and
 * never masks by itself. `customerKey` carries the phone too, so it never
 * leaves the module as is (see `customer-key-sealer.ts`).
 */
import type { PermissionCheck } from './resolve-permissions';
import { canonicalPhone } from './canonical-phone';

export interface StaffPhoneSource {
  countryCode: string | null;
  phone: string | null;
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

/** Hides at least four digits: a short national number keeps only two. */
function mask(national: string): string {
  return national.length >= 10
    ? `${national.slice(0, 2)} **** ${national.slice(-4)}`
    : `**** ${national.slice(-2)}`;
}

export function toStaffPhone(
  source: StaffPhoneSource,
  ability: PermissionCheck,
): string | null {
  if (source.countryCode === null || source.phone === null) return null;
  const typed = digitsOf(source.countryCode);
  // `521` is WhatsApp's Mexican mobile prefix, not a country code of its own.
  const country = typed === '521' ? '52' : typed;
  const full =
    canonicalPhone(source.countryCode, source.phone) ??
    `${country}${digitsOf(source.phone)}`;
  if (ability.can('read', 'CustomerPhone')) return `+${full}`;
  return mask(full.startsWith(country) ? full.slice(country.length) : full);
}
