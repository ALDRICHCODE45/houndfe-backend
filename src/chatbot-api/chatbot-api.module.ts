import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CUSTOMER_REPOSITORY } from '../customers/domain/customer.repository';
import { PrismaCustomerRepository } from '../customers/infrastructure/prisma-customer.repository';
import { PUBLIC_CATALOG_REPOSITORY } from '../public-catalog/application/ports/public-catalog.repository';
import { PrismaPublicCatalogRepository } from '../public-catalog/infrastructure/prisma-public-catalog.repository';
import { EvaluateCartPromotionsUseCase } from '../promotions/application/evaluate-cart-promotions.use-case';
import { EVALUATE_CART_PROMOTIONS_USE_CASE } from '../promotions/application/ports/evaluate-cart-promotions.port';
import { PROMOTION_REPOSITORY } from '../promotions/domain/promotion.repository';
import { PrismaPromotionRepository } from '../promotions/infrastructure/prisma-promotion.repository';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { ChatbotApiService } from './application/chatbot-api.service';
import { ServiceAuthGuard } from './presentation/guards/service-auth.guard';
import { ChatbotApiController } from './presentation/chatbot-api.controller';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import {
  BOT_AUDIT_LOG_REPOSITORY,
  PrismaBotAuditLogRepository,
} from './infrastructure/prisma-bot-audit-log.repository';
import { PrismaServiceCredentialRepository } from './infrastructure/prisma-service-credential.repository';
import { BotAuditInterceptor } from './presentation/interceptors/bot-audit.interceptor';

@Module({
  imports: [ClsModule, DatabaseModule],
  controllers: [ChatbotApiController],
  providers: [
    ChatbotApiService,
    ServiceAuthGuard,
    BotAuditInterceptor,
    EvaluateCartPromotionsUseCase,
    {
      provide: SERVICE_CREDENTIAL_REPOSITORY,
      useClass: PrismaServiceCredentialRepository,
    },
    {
      provide: BOT_AUDIT_LOG_REPOSITORY,
      useClass: PrismaBotAuditLogRepository,
    },
    {
      provide: PUBLIC_CATALOG_REPOSITORY,
      useClass: PrismaPublicCatalogRepository,
    },
    {
      provide: CUSTOMER_REPOSITORY,
      useClass: PrismaCustomerRepository,
    },
    {
      provide: PROMOTION_REPOSITORY,
      useClass: PrismaPromotionRepository,
    },
    {
      provide: EVALUATE_CART_PROMOTIONS_USE_CASE,
      useExisting: EvaluateCartPromotionsUseCase,
    },
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY, ServiceAuthGuard, ChatbotApiService],
})
export class ChatbotApiModule {}
