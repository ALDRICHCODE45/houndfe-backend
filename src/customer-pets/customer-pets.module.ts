import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BOT_AUDIT_LOG_REPOSITORY,
  PrismaBotAuditLogRepository,
} from '../chatbot-api/infrastructure/prisma-bot-audit-log.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { BotAuditInterceptor } from '../chatbot-api/presentation/interceptors/bot-audit.interceptor';
import { CustomerPetsService } from './application/customer-pets.service';
import { CUSTOMER_PET_REPOSITORY } from './domain/customer-pet.repository';
import { PrismaCustomerPetRepository } from './infrastructure/prisma-customer-pet.repository';
import { CustomerPetBotCreateService } from './presentation/bot/customer-pet-bot-create.service';
import { CustomerPetsBotController } from './presentation/bot/customer-pets-bot.controller';
import { CustomerPetsController } from './presentation/customer-pets.controller';

/**
 * Customer pets (contract v1). T1: the model, the rules and the POS routes
 * under `/customers/:customerId/pets`. `CustomerPetsService` is exported for
 * the sale lines (T3). `AuthModule` supplies the POS guards;
 * `TenantPrismaService` and `ConfigService` come from the global modules.
 *
 * T2: `CustomerPetsBotController` (`/chatbot-api/customers/:customerId/pets`).
 * Its guard and audit interceptor need the credential and audit-log
 * repositories, provided here from the chatbot-api infrastructure instead of
 * importing `ChatbotApiModule`: that module imports `SalesModule`, which will
 * import this one for the sale-line pets (T3), and importing it back would be a
 * module cycle.
 * `ROUTE_RATE_LIMITER` is global (`BotRateLimitModule`).
 */
@Module({
  imports: [AuthModule],
  controllers: [CustomerPetsController, CustomerPetsBotController],
  providers: [
    CustomerPetsService,
    CustomerPetBotCreateService,
    {
      provide: CUSTOMER_PET_REPOSITORY,
      useClass: PrismaCustomerPetRepository,
    },
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
  ],
  exports: [CustomerPetsService],
})
export class CustomerPetsModule {}
