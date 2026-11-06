/**
 * shipping-zones / T3 — quote engine settings, read from the environment
 * with safe defaults (docs/shipping-quotes.md §6). The boot schema
 * (`env.validation.ts`) already rejects malformed SHIPPING_* values; the
 * fallbacks here only cover callers that skip it (tests, scripts).
 */
import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_SHIPPING_CREDIT_RULE,
  type ShippingCreditRule,
} from './domain/shipping-credit';

export interface ShippingQuotesConfig {
  ttlMinutes: number;
  carrierTimeoutMs: number;
  credit: ShippingCreditRule;
  /** Dev/tests only; never honored when NODE_ENV=production. */
  fakeCarrierEnabled: boolean;
  isProduction: boolean;
}

export const SHIPPING_QUOTES_CONFIG = Symbol('SHIPPING_QUOTES_CONFIG');

export function integer(
  config: ConfigService,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function flag(config: ConfigService, key: string, fallback: boolean): boolean {
  const raw = config.get<string | boolean>(key);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

export function readShippingQuotesConfig(
  config: ConfigService,
): ShippingQuotesConfig {
  const defaults = DEFAULT_SHIPPING_CREDIT_RULE;
  return {
    ttlMinutes: integer(config, 'SHIPPING_QUOTE_TTL_MINUTES', 30, 1, 1440),
    carrierTimeoutMs: integer(
      config,
      'SHIPPING_CARRIER_TIMEOUT_MS',
      15000,
      100,
      120000,
    ),
    credit: {
      perUnitCreditCents: integer(
        config,
        'SHIPPING_CREDIT_PER_UNIT_CENTS',
        defaults.perUnitCreditCents,
        0,
        100_000_000,
      ),
      unitPriceThresholdCents: integer(
        config,
        'SHIPPING_CREDIT_UNIT_PRICE_THRESHOLD_CENTS',
        defaults.unitPriceThresholdCents,
        0,
        100_000_000,
      ),
      appliesToSurcharge: flag(
        config,
        'SHIPPING_CREDIT_APPLIES_TO_SURCHARGE',
        defaults.appliesToSurcharge,
      ),
    },
    fakeCarrierEnabled: flag(config, 'SHIPPING_FAKE_CARRIER_ENABLED', false),
    isProduction: config.get<string>('NODE_ENV') === 'production',
  };
}
