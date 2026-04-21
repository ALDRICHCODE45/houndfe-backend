/**
 * PromotionsModule - NestJS module for the Promotions bounded context.
 *
 * Registers:
 * - PrismaPromotionRepository as IPromotionRepository adapter (via Symbol token)
 * - PromotionsService for promotion CRUD + end operation
 * - PromotionsController for HTTP endpoints
 *
 * Imports AuthModule for JWT + CASL permission guards.
 * Exports PromotionsService so other modules can use it if needed.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { PrismaPromotionRepository } from './infrastructure/prisma-promotion.repository';
import { PROMOTION_REPOSITORY } from './domain/promotion.repository';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  controllers: [PromotionsController],
  providers: [
    PromotionsService,
    {
      provide: PROMOTION_REPOSITORY,
      useClass: PrismaPromotionRepository,
    },
  ],
  exports: [PromotionsService],
})
export class PromotionsModule {}
