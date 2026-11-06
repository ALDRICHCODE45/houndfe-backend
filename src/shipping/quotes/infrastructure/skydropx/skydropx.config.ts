/**
 * shipping-zones / T6 — Skydropx settings, from the environment only
 * (docs/shipping-quotes.md §6.1).
 *
 * Skydropx is configured only when SKYDROPX_CLIENT_ID and
 * SKYDROPX_CLIENT_SECRET are both present; otherwise this returns null and
 * the carrier is not registered. The credentials live only in the object
 * returned here and in the HTTP client: never logged, never exported through
 * `SHIPPING_QUOTES_CONFIG`.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ShippingCarrier } from '../../domain/shipping-carrier.port';
import { integer } from '../../shipping-quotes.config';
import {
  SkydropxHttpClient,
  SkydropxRateLimiter,
} from './skydropx-http.client';
import { SkydropxShippingCarrier } from './skydropx-shipping-carrier';

/** Production API host. Sandbox: https://sb-pro.skydropx.com (docs §6.1). */
export const SKYDROPX_DEFAULT_BASE_URL = 'https://api-pro.skydropx.com';
/** Skydropx allows 2 requests per second. */
export const SKYDROPX_MIN_REQUEST_INTERVAL_MS = 500;
/** Time kept between the Skydropx deadline and the engine timeout. */
const ENGINE_TIMEOUT_MARGIN_MS = 500;

export interface SkydropxConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  deadlineMs: number;
}

function text(config: ConfigService, key: string): string | null {
  const raw = config.get<string>(key);
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function readSkydropxConfig(
  config: ConfigService,
  carrierTimeoutMs: number,
): SkydropxConfig | null {
  const clientId = text(config, 'SKYDROPX_CLIENT_ID');
  const clientSecret = text(config, 'SKYDROPX_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  const baseUrl =
    text(config, 'SKYDROPX_BASE_URL') ?? SKYDROPX_DEFAULT_BASE_URL;
  let protocol: string | null = null;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    protocol = null;
  }
  if (protocol !== 'https:') {
    // Never send the credentials to a host nobody meant: stay unregistered.
    new Logger('ShippingCarriers').warn(
      'SKYDROPX_BASE_URL is not an https URL; Skydropx is not registered',
    );
    return null;
  }

  const deadlineMs = integer(
    config,
    'SKYDROPX_QUOTE_DEADLINE_MS',
    12000,
    1000,
    120000,
  );
  return {
    clientId,
    clientSecret,
    baseUrl,
    requestTimeoutMs: integer(
      config,
      'SKYDROPX_REQUEST_TIMEOUT_MS',
      5000,
      500,
      60000,
    ),
    pollIntervalMs: integer(
      config,
      'SKYDROPX_POLL_INTERVAL_MS',
      1000,
      SKYDROPX_MIN_REQUEST_INTERVAL_MS,
      10000,
    ),
    // Must end before the engine aborts the carrier, so a slow quotation
    // fails as a Skydropx failure instead of an anonymous timeout.
    deadlineMs: Math.max(
      Math.min(deadlineMs, carrierTimeoutMs - ENGINE_TIMEOUT_MARGIN_MS),
      1,
    ),
  };
}

export function createSkydropxCarrier(config: SkydropxConfig): ShippingCarrier {
  const http = new SkydropxHttpClient({
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    requestTimeoutMs: config.requestTimeoutMs,
    limiter: new SkydropxRateLimiter(SKYDROPX_MIN_REQUEST_INTERVAL_MS),
  });
  return new SkydropxShippingCarrier(http, {
    pollIntervalMs: config.pollIntervalMs,
    deadlineMs: config.deadlineMs,
  });
}
