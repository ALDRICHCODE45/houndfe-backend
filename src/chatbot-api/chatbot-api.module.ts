import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CUSTOMER_REPOSITORY } from '../customers/domain/customer.repository';
import { PrismaCustomerRepository } from '../customers/infrastructure/prisma-customer.repository';
import { PUBLIC_CATALOG_REPOSITORY } from '../public-catalog/application/ports/public-catalog.repository';
import { PrismaPublicCatalogRepository } from '../public-catalog/infrastructure/prisma-public-catalog.repository';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { ChatbotApiService } from './application/chatbot-api.service';
import { CheckoutService } from './application/checkout.service';
import { CheckoutController } from './presentation/checkout.controller';
import { ServiceAuthGuard } from './presentation/guards/service-auth.guard';
import { ChatbotApiController } from './presentation/chatbot-api.controller';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import {
  BOT_AUDIT_LOG_REPOSITORY,
  PrismaBotAuditLogRepository,
} from './infrastructure/prisma-bot-audit-log.repository';
import { PrismaServiceCredentialRepository } from './infrastructure/prisma-service-credential.repository';
import { BotAuditInterceptor } from './presentation/interceptors/bot-audit.interceptor';
import { SalesModule } from '../sales/sales.module';
import { PromotionsModule } from '../promotions/promotions.module';

@Module({
  // PromotionsModule supplies the cart evaluator and the POS engine it shares
  // with bot sale confirmation, so preview and sale price identically.
  imports: [ClsModule, DatabaseModule, SalesModule, PromotionsModule],
  controllers: [ChatbotApiController, CheckoutController],
  providers: [
    ChatbotApiService,
    CheckoutService,
    ServiceAuthGuard,
    BotAuditInterceptor,
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
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY, ServiceAuthGuard, ChatbotApiService],
})
export class ChatbotApiModule {}
