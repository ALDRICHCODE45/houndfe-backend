/**
 * shipping-zones / T6 (S6) — Skydropx quotation payloads ↔ carrier port.
 *
 * Money: a rate's `total` (shipping + IVA + service fee, MXN) arrives as a
 * decimal string (sometimes a JSON number). It is converted to integer cents
 * from its digits, never through float multiplication; a third decimal
 * rounds half up. Anything that is not a plain non-negative decimal is
 * rejected and its rate skipped.
 *
 * A rate is usable only with `success: true`, no error messages and a
 * positive total (a 0 total is not a price). With `status` present it must
 * be a priced status. Without `status` (absent or null; the chatbot
 * reference never reads it) the reference validations apply instead:
 * currency MXN, provider display and service names non-empty after trim and
 * at most 128 characters, whole days ≥ 0, and a canonical decimal total
 * (no padding or leading zeros, at most 2 decimals).
 */
import type {
  CarrierParcel,
  CarrierRateOption,
} from '../../domain/shipping-carrier.port';

/** Rate statuses that carry a price (Skydropx `rates[].status`). */
const PRICED_STATUSES = new Set([
  'approved',
  'price_found_internal',
  'price_found_external',
  'coverage_checked',
]);

const DECIMAL = /^(\d{1,13})(?:\.(\d+))?$/;
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MAX_NAME_LENGTH = 128;

export function parseMxnToCents(value: unknown): number | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const cents =
    Number(match[1]) * 100 +
    Number(fraction.padEnd(2, '0').slice(0, 2)) +
    (fraction.length > 2 && fraction[2] >= '5' ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function name(value: unknown): string | null {
  const text = label(value);
  return text !== null && text.length <= MAX_NAME_LENGTH ? text : null;
}

/** Chatbot-reference checks for a rate that carries no `status`. */
function passesReferenceChecks(rate: Record<string, unknown>): boolean {
  const total = rate.total;
  const days = rate.days;
  return (
    rate.currency_code === 'MXN' &&
    name(rate.provider_display_name) !== null &&
    name(rate.provider_service_name) !== null &&
    typeof days === 'number' &&
    Number.isSafeInteger(days) &&
    days >= 0 &&
    ((typeof total === 'string' && CANONICAL_DECIMAL.test(total)) ||
      (typeof total === 'number' && CANONICAL_DECIMAL.test(String(total))))
  );
}

function mapRate(raw: unknown, validUntil: Date): CarrierRateOption | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rate = raw as Record<string, unknown>;
  if (rate.success !== true) return null;
  if (rate.status === undefined || rate.status === null) {
    if (!passesReferenceChecks(rate)) return null;
  } else if (
    typeof rate.status !== 'string' ||
    !PRICED_STATUSES.has(rate.status)
  ) {
    return null;
  }
  if (Array.isArray(rate.error_messages) && rate.error_messages.length > 0) {
    return null;
  }
  if (
    rate.currency_code !== undefined &&
    rate.currency_code !== null &&
    (typeof rate.currency_code !== 'string' ||
      rate.currency_code.toUpperCase() !== 'MXN')
  ) {
    return null;
  }
  const totalCents = parseMxnToCents(rate.total);
  if (totalCents === null || totalCents <= 0) return null;
  const provider =
    label(rate.provider_display_name) ?? label(rate.provider_name);
  if (!provider) return null;
  const days = rate.days;
  return {
    carrier: `Skydropx/${provider}`,
    service:
      label(rate.provider_service_name) ??
      label(rate.provider_service_code) ??
      'standard',
    totalCents,
    etaDays:
      typeof days === 'number' && Number.isInteger(days) && days >= 0
        ? days
        : null,
    rateId: label(rate.id),
    validUntil,
  };
}

/** Usable rates only: failed, unpriced or malformed rates are dropped. */
export function mapSkydropxRates(
  rates: unknown,
  validUntil: Date,
): CarrierRateOption[] {
  if (!Array.isArray(rates)) return [];
  return rates.flatMap((raw) => {
    const option = mapRate(raw, validUntil);
    return option ? [option] : [];
  });
}

/**
 * Skydropx wants whole centimetres (at least 1) and the weight in kilograms
 * with gram precision (at least 1 kg). Values round UP so the declared
 * parcel is never smaller or lighter than the real one.
 */
export function toSkydropxParcel(parcel: CarrierParcel): {
  length: number;
  width: number;
  height: number;
  weight: number;
} {
  const cm = (value: number) => Math.max(1, Math.ceil(value));
  return {
    length: cm(parcel.lengthCm),
    width: cm(parcel.widthCm),
    height: cm(parcel.heightCm),
    weight: Math.max(1, Math.ceil(parcel.weightG) / 1000),
  };
}
