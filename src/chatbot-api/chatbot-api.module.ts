import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { PUBLIC_CATALOG_REPOSITORY } from '../public-catalog/application/ports/public-catalog.repository';
import { PrismaPublicCatalogRepository } from '../public-catalog/infrastructure/prisma-public-catalog.repository';
import { ChatbotApiService } from './application/chatbot-api.service';
import { ServiceAuthGuard } from './presentation/guards/service-auth.guard';
import { ChatbotApiController } from './presentation/chatbot-api.controller';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from './infrastructure/prisma-service-credential.repository';

@Module({
  imports: [ClsModule],
  controllers: [ChatbotApiController],
  providers: [
    ChatbotApiService,
    ServiceAuthGuard,
    {
      provide: SERVICE_CREDENTIAL_REPOSITORY,
      useClass: PrismaServiceCredentialRepository,
    },
    {
      provide: PUBLIC_CATALOG_REPOSITORY,
      useClass: PrismaPublicCatalogRepository,
    },
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY, ServiceAuthGuard, ChatbotApiService],
})
export class ChatbotApiModule {}
