import { Module } from '@nestjs/common';
import { SERVICE_CREDENTIAL_REPOSITORY } from './domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from './infrastructure/prisma-service-credential.repository';

@Module({
  providers: [
    {
      provide: SERVICE_CREDENTIAL_REPOSITORY,
      useClass: PrismaServiceCredentialRepository,
    },
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY],
})
export class ChatbotApiModule {}
