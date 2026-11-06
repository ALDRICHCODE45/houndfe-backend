/**
 * shipping-zones / T1 — DeliveryZonesModule.
 *
 * Store-side delivery zones (S1) and zone validations (S2, S3), plus the bot
 * requester port the human-decisions bot routes consume
 * (`DELIVERY_ZONE_BOT_REPOSITORY`, exported). Contract: docs/delivery-zones.md.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { DELIVERY_ZONE_BOT_REPOSITORY } from './domain/delivery-zone-bot.repository';
import { DELIVERY_ZONE_REPOSITORY } from './domain/delivery-zone.repository';
import { DELIVERY_ZONE_VALIDATION_REPOSITORY } from './domain/delivery-zone-validation.repository';
import { DELIVERY_ZONE_VALIDATOR_LOOKUP } from './domain/delivery-zone-validator-lookup';
import { PrismaDeliveryZoneBotRepository } from './infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaDeliveryZoneRepository } from './infrastructure/prisma-delivery-zone.repository';
import { PrismaDeliveryZoneValidationRepository } from './infrastructure/prisma-delivery-zone-validation.repository';
import { PrismaDeliveryZoneValidatorLookup } from './infrastructure/prisma-delivery-zone-validator-lookup';
import { DeliveryZoneHttpFilter } from './presentation/delivery-zone-http.filter';
import { DeliveryZoneValidationsController } from './presentation/delivery-zone-validations.controller';
import { DeliveryZonesController } from './presentation/delivery-zones.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DeliveryZonesController, DeliveryZoneValidationsController],
  providers: [
    DeliveryZoneHttpFilter,
    {
      provide: DELIVERY_ZONE_REPOSITORY,
      useClass: PrismaDeliveryZoneRepository,
    },
    {
      provide: DELIVERY_ZONE_VALIDATION_REPOSITORY,
      useClass: PrismaDeliveryZoneValidationRepository,
    },
    {
      provide: DELIVERY_ZONE_BOT_REPOSITORY,
      useClass: PrismaDeliveryZoneBotRepository,
    },
    {
      provide: DELIVERY_ZONE_VALIDATOR_LOOKUP,
      useClass: PrismaDeliveryZoneValidatorLookup,
    },
  ],
  // The validator lookup feeds the top-level DeliveryZoneInngestRegistrar;
  // the zone port feeds the shipping quote engine (T3).
  exports: [
    DELIVERY_ZONE_BOT_REPOSITORY,
    DELIVERY_ZONE_VALIDATOR_LOOKUP,
    DELIVERY_ZONE_REPOSITORY,
  ],
})
export class DeliveryZonesModule {}
