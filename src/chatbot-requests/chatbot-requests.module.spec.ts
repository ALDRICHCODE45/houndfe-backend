import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { ChatbotRequestCommandsService } from './application/chatbot-request-commands.service';
import { ChatbotRequestsModule } from './chatbot-requests.module';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';

@Module({
  providers: [
    { provide: TenantPrismaService, useValue: {} },
    { provide: PrismaService, useValue: {} },
  ],
  exports: [TenantPrismaService, PrismaService],
})
class IsolatedDatabaseModule {}

@Module({})
class IsolatedAuthModule {}

describe('ChatbotRequestsModule wiring', () => {
  it('resolves the controller and the service without database access', async () => {
    const pass = { canActivate: () => true };
    const module = await Test.createTestingModule({
      imports: [ChatbotRequestsModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(IsolatedDatabaseModule)
      .overrideModule(AuthModule)
      .useModule(IsolatedAuthModule)
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(TenantContextGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();

    expect(module.get(ChatbotRequestCommandsController)).toBeDefined();
    expect(module.get(ChatbotRequestCommandsService)).toBeDefined();
  });
});
