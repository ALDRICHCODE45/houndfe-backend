import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ServiceAuthGuard } from './presentation/guards/service-auth.guard';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from './infrastructure/prisma-service-credential.repository';

@Module({
  imports: [ClsModule],
  providers: [
    ServiceAuthGuard,
    {
      provide: SERVICE_CREDENTIAL_REPOSITORY,
      useClass: PrismaServiceCredentialRepository,
    },
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY, ServiceAuthGuard],
})
export class ChatbotApiModule {}
