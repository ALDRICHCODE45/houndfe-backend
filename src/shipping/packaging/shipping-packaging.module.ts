/**
 * ShippingPackagingModule — shipping-zones / T2 (S4, S5).
 *
 * Packaging per product/variant, standard boxes and the shipping origin per
 * sucursal, plus the pure packing rule. `ProductPackagingService` is exported
 * with `ShippingSettingsService` so the quote engine (T3) can resolve
 * packaging for order lines and the active boxes.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { ProductPackagingService } from './application/product-packaging.service';
import { ProductPackagingController } from './presentation/product-packaging.controller';
import { ShippingSettingsService } from './application/shipping-settings.service';
import { ShippingSettingsController } from './presentation/shipping-settings.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ProductPackagingController, ShippingSettingsController],
  providers: [ProductPackagingService, ShippingSettingsService],
  exports: [ProductPackagingService, ShippingSettingsService],
})
export class ShippingPackagingModule {}
