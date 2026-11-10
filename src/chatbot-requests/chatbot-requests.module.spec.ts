import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { DELIVERY_ZONE_BOT_REPOSITORY } from '../delivery-zones/domain/delivery-zone-bot.repository';
import { AuthModule } from '../auth/auth.module';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  CHATBOT_REQUEST_RESOLVER,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { SalesModule } from '../sales/sales.module';
import { ChatbotRequestWrapperModule } from './chatbot-request-wrapper.module';
import { BotRequestIntakeService } from './application/bot-request-intake.service';
import { ChatbotRequestsModule } from './chatbot-requests.module';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { WrappedRequestResolutionModule } from './wrapped-request-resolution.module';
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

// The stock, zone and receipt modules need the whole application; the
// resolve adapter is covered by the wrapping integration spec.
@Module({
  providers: [{ provide: CHATBOT_REQUEST_RESOLVER, useValue: {} }],
  exports: [CHATBOT_REQUEST_RESOLVER],
})
class IsolatedResolutionModule {}

// The bot guard's collaborators (credential repository, CLS) and the zone
// intake port come from modules that need the whole application.
@Module({
  providers: [
    { provide: SERVICE_CREDENTIAL_REPOSITORY, useValue: {} },
    { provide: ClsService, useValue: {} },
  ],
  exports: [SERVICE_CREDENTIAL_REPOSITORY, ClsService],
})
class IsolatedChatbotApiModule {}

@Module({
  providers: [{ provide: DELIVERY_ZONE_BOT_REPOSITORY, useValue: {} }],
  exports: [DELIVERY_ZONE_BOT_REPOSITORY],
})
class IsolatedZonesModule {}

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
      .overrideModule(WrappedRequestResolutionModule)
      .useModule(IsolatedResolutionModule)
      .overrideModule(ChatbotApiModule)
      .useModule(IsolatedChatbotApiModule)
      .overrideModule(DeliveryZonesModule)
      .useModule(IsolatedZonesModule)
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(TenantContextGuard)
      .useValue(pass)
      .overrideGuard(PermissionsGuard)
      .useValue(pass)
      .compile();

    expect(module.get(ChatbotRequestCommandsController)).toBeDefined();
    expect(module.get(ChatbotRequestCommandsService)).toBeDefined();
    expect(module.get(BotRequestsController)).toBeDefined();
    expect(module.get(BotRequestIntakeService)).toBeDefined();
  });

  // The flows take the wrapper as an optional dependency (so their own specs
  // build without it); this keeps production from silently losing the hook.
  it.each([
    ['HumanDecisionsModule', HumanDecisionsModule],
    ['DeliveryZonesModule', DeliveryZonesModule],
    ['ReceiptsModule', ReceiptsModule],
    ['SalesModule', SalesModule],
  ])('%s imports the wrapper module', (_name, module) => {
    expect(Reflect.getMetadata('imports', module)).toContain(
      ChatbotRequestWrapperModule,
    );
  });

  it('imports the resolution module that reaches the old use cases', () => {
    expect(Reflect.getMetadata('imports', ChatbotRequestsModule)).toContain(
      WrappedRequestResolutionModule,
    );
  });
});
