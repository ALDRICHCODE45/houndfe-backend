/**
 * PromotionsModule - NestJS module for the Promotions bounded context.
 *
 * Registers:
 * - PrismaPromotionRepository as IPromotionRepository adapter (via Symbol token)
 * - PromotionsService for promotion CRUD + end operation
 * - PromotionsController for HTTP endpoints
 * - EvaluateCartPromotionsUseCase (chatbot-api path)
 * - PosEvaluatePromotionsUseCase (POS sale recompute path, Unit 2 — unwired)
 *
 * Imports AuthModule for JWT + CASL permission guards.
 * Exports PromotionsService, both use-case symbols, so other modules
 * can import this module and resolve the engine by Symbol.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { PrismaPromotionRepository } from './infrastructure/prisma-promotion.repository';
import { PROMOTION_REPOSITORY } from './domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './application/evaluate-cart-promotions.use-case';
import { EVALUATE_CART_PROMOTIONS_USE_CASE } from './application/ports/evaluate-cart-promotions.port';
import { PosEvaluatePromotionsUseCase } from './application/pos-evaluate-promotions.use-case';
import { POS_EVALUATE_PROMOTIONS_USE_CASE } from './application/ports/pos-evaluate-promotions.port';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  controllers: [PromotionsController],
  providers: [
    PromotionsService,
    EvaluateCartPromotionsUseCase,
    PosEvaluatePromotionsUseCase,
    {
      provide: PROMOTION_REPOSITORY,
      useClass: PrismaPromotionRepository,
    },
    {
      provide: EVALUATE_CART_PROMOTIONS_USE_CASE,
      useExisting: EvaluateCartPromotionsUseCase,
    },
    {
      provide: POS_EVALUATE_PROMOTIONS_USE_CASE,
      useExisting: PosEvaluatePromotionsUseCase,
    },
  ],
  exports: [
    PromotionsService,
    EVALUATE_CART_PROMOTIONS_USE_CASE,
    POS_EVALUATE_PROMOTIONS_USE_CASE,
  ],
})
export class PromotionsModule {}
