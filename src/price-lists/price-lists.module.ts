import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PriceListsController } from './price-lists.controller';
import { PriceListsService } from './price-lists.service';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  controllers: [PriceListsController],
  providers: [PriceListsService],
  exports: [PriceListsService],
})
export class PriceListsModule {}
