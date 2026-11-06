/**
 * shipping-zones / T1 (S1, S3) — pure delivery-zone rules.
 *
 * Mirrors the migration CHECKs (`*_type_shape`, `*_surcharge_range`,
 * `*_eta_days_range`) so a bad payload is a sanitized 400 before any write:
 *   FREE          etaDays required, surchargeCents forbidden.
 *   SURCHARGE     etaDays and surchargeCents (1..100 000 000) required.
 *   CARRIER_ONLY  neither (carrier quotes bring their own ETA).
 *   DENIED        neither.
 *
 * `computeValidationUrgency` derives the WhatsApp 24 h free-text window from
 * the customer's last message ("Urgencia + plazo").
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const DELIVERY_ZONE_TYPES = [
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
  'DENIED',
] as const;

export type DeliveryZoneTypeValue = (typeof DELIVERY_ZONE_TYPES)[number];

/** Stable, value-free code for every zone-shape failure. */
export const INVALID_DELIVERY_ZONE_CODE = 'INVALID_DELIVERY_ZONE';

export const MIN_SURCHARGE_CENTS = 1;
export const MAX_SURCHARGE_CENTS = 100_000_000;
export const MIN_ETA_DAYS = 0;
export const MAX_ETA_DAYS = 60;

/** WhatsApp free-text window after the customer's last message. */
export const CUSTOMER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WARNING_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export const ZIP_CODE_PATTERN = /^[0-9]{5}$/;

export interface ZoneSettingsInput {
  type: DeliveryZoneTypeValue;
  surchargeCents?: number | null;
  etaDays?: number | null;
}

export interface ZoneSettings {
  type: DeliveryZoneTypeValue;
  surchargeCents: number | null;
  etaDays: number | null;
}

export type ValidationUrgencyLevel = 'OK' | 'WARNING' | 'CRITICAL' | 'EXPIRED';

export interface ValidationUrgency {
  /** Canonical UTC ISO: `lastCustomerMessageAt + 24 h`. */
  deadlineAt: string;
  /** Hours left in the window, one decimal, never negative. */
  hoursLeft: number;
  level: ValidationUrgencyLevel;
}

function fail(message: string): never {
  throw new InvalidArgumentError(message, INVALID_DELIVERY_ZONE_CODE);
}

export function isDeliveryZoneType(
  value: unknown,
): value is DeliveryZoneTypeValue {
  return (
    typeof value === 'string' &&
    (DELIVERY_ZONE_TYPES as readonly string[]).includes(value)
  );
}

export function isValidZipCode(value: unknown): value is string {
  return typeof value === 'string' && ZIP_CODE_PATTERN.test(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Validate and normalize the type/surcharge/ETA triple (absent -> null). */
export function normalizeZoneSettings(input: ZoneSettingsInput): ZoneSettings {
  if (!isDeliveryZoneType(input.type)) {
    return fail('Unknown delivery zone type');
  }
  const surchargeCents = input.surchargeCents ?? null;
  const etaDays = input.etaDays ?? null;
  const ownDelivery = input.type === 'FREE' || input.type === 'SURCHARGE';

  if (input.type === 'SURCHARGE') {
    if (
      !isIntegerInRange(
        surchargeCents,
        MIN_SURCHARGE_CENTS,
        MAX_SURCHARGE_CENTS,
      )
    ) {
      return fail(
        'A SURCHARGE zone requires a positive integer surchargeCents',
      );
    }
  } else if (surchargeCents !== null) {
    return fail('surchargeCents is only allowed for a SURCHARGE zone');
  }

  if (ownDelivery) {
    if (!isIntegerInRange(etaDays, MIN_ETA_DAYS, MAX_ETA_DAYS)) {
      return fail('FREE and SURCHARGE zones require etaDays between 0 and 60');
    }
  } else if (etaDays !== null) {
    return fail('etaDays is only allowed for FREE and SURCHARGE zones');
  }

  return { type: input.type, surchargeCents, etaDays };
}

/** Deadline and urgency of a pending validation for its oldest requester. */
export function computeValidationUrgency(
  lastCustomerMessageAt: Date,
  now: Date,
): ValidationUrgency {
  const deadlineMs = lastCustomerMessageAt.getTime() + CUSTOMER_REPLY_WINDOW_MS;
  const leftMs = Math.max(0, deadlineMs - now.getTime());
  const level: ValidationUrgencyLevel =
    leftMs === 0
      ? 'EXPIRED'
      : leftMs < CRITICAL_THRESHOLD_MS
        ? 'CRITICAL'
        : leftMs < WARNING_THRESHOLD_MS
          ? 'WARNING'
          : 'OK';
  return {
    deadlineAt: new Date(deadlineMs).toISOString(),
    hoursLeft: Math.floor(leftMs / 360_000) / 10,
    level,
  };
}
