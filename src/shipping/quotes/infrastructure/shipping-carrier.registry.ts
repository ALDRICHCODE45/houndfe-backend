/**
 * shipping-zones / T3 (S6) — the configured carriers.
 *
 * Real adapters (Skydropx since T6, Envíos Perros when there is a token)
 * join this list when their credentials are present; the engine quotes
 * whatever the list holds, so adding one changes no contract.
 */
import { Logger } from '@nestjs/common';
import type { ShippingCarrier } from '../domain/shipping-carrier.port';
import type { ShippingQuotesConfig } from '../shipping-quotes.config';
import { FakeShippingCarrier } from './fake-shipping-carrier';
import {
  createSkydropxCarrier,
  type SkydropxConfig,
} from './skydropx/skydropx.config';

export function buildShippingCarriers(
  config: ShippingQuotesConfig,
  skydropx: SkydropxConfig | null = null,
): ShippingCarrier[] {
  const logger = new Logger('ShippingCarriers');
  const carriers: ShippingCarrier[] = [];
  if (skydropx) {
    carriers.push(createSkydropxCarrier(skydropx));
    // The base URL only (validated in readSkydropxConfig): never credentials.
    logger.log(`Skydropx carrier registered (${skydropx.baseUrl})`);
  }
  if (config.fakeCarrierEnabled) {
    if (config.isProduction) {
      logger.warn('SHIPPING_FAKE_CARRIER_ENABLED is ignored in production');
    } else {
      carriers.push(new FakeShippingCarrier());
    }
  }
  return carriers;
}
