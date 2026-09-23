/**
 * PromotionsModule - NestJS module for the Promotions bounded context.
 *
 * Registers:
 * - PrismaPromotionRepository as IPromotionRepository adapter (via Symbol token)
 * - PromotionsService for promotion CRUD + end operation
 * - PromotionsController for HTTP endpoints
 * - EvaluateCartPromotionsUseCase (chatbot-api path)
 * - PosEvaluatePromotionsUseCase (POS sale recompute path, Unit 2 — unwired)
 * - PROMOTION_ALERT_LOOKUP → PrismaPromotionAlertLookupRepository, an
 *   inert tenant-qualified promotion-title lookup exported for the
 *   near-capacity alert email registrar (pca-3b4b/pca-3b4c). Nothing in
 *   the active delivery path resolves it yet.
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
import { PrismaPromotionUsageRepository } from './infrastructure/prisma-promotion-usage.repository';
import { PROMOTION_USAGE_REPOSITORY } from './domain/promotion-usage.repository';
import { PrismaPromotionAlertLookupRepository } from './infrastructure/prisma-promotion-alert-lookup.repository';
import { PROMOTION_ALERT_LOOKUP } from './domain/promotion-alert-lookup.repository';
import { EvaluateCartPromotionsUseCase } from './application/evaluate-cart-promotions.use-case';
import { EVALUATE_CART_PROMOTIONS_USE_CASE } from './application/ports/evaluate-cart-promotions.port';
import { PosEvaluatePromotionsUseCase } from './application/pos-evaluate-promotions.use-case';
import { POS_EVALUATE_PROMOTIONS_USE_CASE } from './application/ports/pos-evaluate-promotions.port';
import {
  BatchDeleteModule,
  BatchDeleteOrchestrator,
} from '../shared/batch-delete';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { OutboxModule } from '../shared/outbox/outbox.module';
import type { BatchDeletableService } from '../shared/batch-delete/batch-delete.types';

@Module({
  imports: [
    AuthModule, // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
    BatchDeleteModule.forFeature(),
    // Provides OutboxWriterService for the in-transaction near-capacity alert
    // written by PrismaPromotionUsageRepository.claimForSale.
    OutboxModule,
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
      provide: PROMOTION_USAGE_REPOSITORY,
      useClass: PrismaPromotionUsageRepository,
    },
    {
      // Inert pca-3b4a seam: exported for the near-capacity alert email
      // registrar so the notification function can resolve a promotion's
      // display title without importing the promotions application layer.
      provide: PROMOTION_ALERT_LOOKUP,
      useClass: PrismaPromotionAlertLookupRepository,
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
    PROMOTION_USAGE_REPOSITORY,
    PROMOTION_ALERT_LOOKUP,
  ],
})
export class PromotionsModule {}
