/**
 * ShippingQuotesModule — shipping-zones / T3 (S6-S9).
 *
 * Carrier registry, quote persistence and the checkout verifier. It re-exports
 * the packaging services and the zone port the bot quote flow
 * (`chatbot-api/application/shipping-quote.service.ts`) composes with the
 * sale repricing. Contract: docs/shipping-quotes.md.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryZonesModule } from '../../delivery-zones/delivery-zones.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { ShippingPackagingModule } from '../packaging/shipping-packaging.module';
import { ShippingQuoteVerifier } from './application/shipping-quote-verifier.service';
import { SHIPPING_CARRIERS } from './domain/shipping-carrier.port';
import { SHIPPING_QUOTE_REPOSITORY } from './domain/shipping-quote.repository';
import { PrismaShippingQuoteRepository } from './infrastructure/prisma-shipping-quote.repository';
import { buildShippingCarriers } from './infrastructure/shipping-carrier.registry';
import { readSkydropxConfig } from './infrastructure/skydropx/skydropx.config';
import {
  readShippingQuotesConfig,
  SHIPPING_QUOTES_CONFIG,
  type ShippingQuotesConfig,
} from './shipping-quotes.config';

@Module({
  imports: [DatabaseModule, ShippingPackagingModule, DeliveryZonesModule],
  providers: [
    {
      provide: SHIPPING_QUOTES_CONFIG,
      inject: [ConfigService],
      useFactory: readShippingQuotesConfig,
    },
    {
      provide: SHIPPING_CARRIERS,
      inject: [SHIPPING_QUOTES_CONFIG, ConfigService],
      useFactory: (config: ShippingQuotesConfig, env: ConfigService) =>
        buildShippingCarriers(
          config,
          readSkydropxConfig(env, config.carrierTimeoutMs),
        ),
    },
    {
      provide: SHIPPING_QUOTE_REPOSITORY,
      useClass: PrismaShippingQuoteRepository,
    },
    ShippingQuoteVerifier,
  ],
  exports: [
    SHIPPING_QUOTES_CONFIG,
    SHIPPING_CARRIERS,
    SHIPPING_QUOTE_REPOSITORY,
    ShippingQuoteVerifier,
    ShippingPackagingModule,
    DeliveryZonesModule,
  ],
})
export class ShippingQuotesModule {}
