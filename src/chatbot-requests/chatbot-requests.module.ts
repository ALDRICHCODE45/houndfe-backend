/**
 * Chatbot request inbox (human-intervention units 2, 3 and 5): staff commands
 * claim, release, reassign, cancel and resolve, and the bot's create and
 * cancel routes. `AuthModule` provides `JwtAuthGuard` and `PermissionsGuard`;
 * `ActiveUserGuard` resolves `PrismaService` from the global `DatabaseModule`;
 * `ChatbotApiModule` supplies the bot guard's credential repository.
 *
 * The bot create route runs the legacy RESTOCK / EXPIRATION / DELIVERY_ZONE
 * intake repositories, so this module instantiates them (stateless adapters)
 * with the wrapper hook; `HumanDecisionsModule` still owns the old routes.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import { EXPIRATION_INTAKE_REPOSITORY } from '../human-decisions/domain/expiration-intake.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../human-decisions/domain/restock-intake.repository';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import {
  BOT_INTAKE_STORE,
  BotRequestIntakeService,
  LEGACY_INTAKE,
} from './application/bot-request-intake.service';
import { ChatbotRequestWrapperModule } from './chatbot-request-wrapper.module';
import { WrappedRequestResolutionModule } from './wrapped-request-resolution.module';
import { LegacyIntakeAdapter } from './infrastructure/legacy-intake.adapter';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WrappedRequestResolutionModule,
    ChatbotApiModule,
    ChatbotRequestWrapperModule,
    DeliveryZonesModule,
  ],
  controllers: [ChatbotRequestCommandsController, BotRequestsController],
  providers: [
    ActiveUserGuard,
    ChatbotRequestHttpFilter,
    ChatbotRequestCommandsService,
    BotRequestIntakeService,
    { provide: BOT_INTAKE_STORE, useClass: PrismaBotIntakeStore },
    { provide: LEGACY_INTAKE, useClass: LegacyIntakeAdapter },
    {
      provide: RESTOCK_INTAKE_REPOSITORY,
      useClass: PrismaRestockIntakeRepository,
    },
    {
      provide: EXPIRATION_INTAKE_REPOSITORY,
      useClass: PrismaExpirationIntakeRepository,
    },
    {
      provide: CHATBOT_REQUEST_COMMAND_STORE,
      useClass: PrismaChatbotRequestCommandStore,
    },
  ],
})
export class ChatbotRequestsModule {}
