/**
 * ShippingPickupModule — shipping-zones / T7 (S10).
 *
 * Sucursal opening hours (store settings) and the pickup location the bot
 * shows for `shipping: { mode: "pickup" }` checkouts and sales.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { OpeningHoursService } from './application/opening-hours.service';
import { PickupLocationService } from './application/pickup-location.service';
import { OpeningHoursController } from './presentation/opening-hours.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [OpeningHoursController],
  providers: [OpeningHoursService, PickupLocationService],
  exports: [OpeningHoursService, PickupLocationService],
})
export class ShippingPickupModule {}
