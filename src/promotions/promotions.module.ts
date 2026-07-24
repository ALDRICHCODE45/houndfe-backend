/**
 * PromotionsModule - NestJS module for the Promotions bounded context.
 *
 * Registers:
 * - PrismaPromotionRepository as IPromotionRepository adapter (via Symbol token)
 * - PromotionsService for promotion CRUD + end operation
 * - PromotionsController for HTTP endpoints
 * - EvaluateCartPromotionsUseCase (chatbot-api path)
 * - PosEvaluatePromotionsUseCase (POS sale recompute path, Unit 2 — unwired)
 * - BatchDeleteModule.forFeature — wires the `POST /promotions/batch-delete`
 *   endpoint via the shared abstraction
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
import {
  BatchDeleteModule,
  BatchDeleteOrchestrator,
  BatchDeleteDto,
} from '../shared/batch-delete';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { BatchDeletableService } from '../shared/batch-delete/batch-delete.types';

@Module({
  imports: [
    AuthModule, // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
    BatchDeleteModule.forFeature(),
  ],
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
      // Build the orchestrator subclass that wires TenantPrismaService
      // + PromotionsService. The factory returns a new concrete
      // orchestrator instance for each injection request — the
      // orchestrator is stateless (it holds no mutable state) so
      // sharing across requests is safe.
      provide: BatchDeleteOrchestrator,
      useFactory: (
        tenantPrisma: TenantPrismaService,
        service: BatchDeletableService,
      ): BatchDeleteOrchestrator =>
        new (class extends BatchDeleteOrchestrator {
          constructor() {
            super(tenantPrisma, service);
          }
        })(),
      inject: [TenantPrismaService, PromotionsService],
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
