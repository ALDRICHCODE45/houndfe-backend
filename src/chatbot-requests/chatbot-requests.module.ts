/**
 * Chatbot request inbox (human-intervention units 2, 3, 4 and 5): staff reads
 * (groups, counts, detail, history, assignable users) and commands claim, release, reassign, cancel, resolve, merge and link-customer, and the bot's create, cancel
 * and feed routes (feed, delivery outcome, pending deliveries, recovery). `AuthModule` provides `JwtAuthGuard` and `PermissionsGuard`;
 * `ActiveUserGuard` resolves `PrismaService` from the global `DatabaseModule`;
 * `ChatbotApiModule` supplies the bot guard's credential repository.
 *
 * The bot create route runs the legacy RESTOCK / EXPIRATION / DELIVERY_ZONE
 * intake repositories, so this module instantiates them (stateless adapters)
 * with the wrapper hook; `HumanDecisionsModule` still owns the old routes.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import { EXPIRATION_INTAKE_REPOSITORY } from '../human-decisions/domain/expiration-intake.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../human-decisions/domain/restock-intake.repository';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import {
  CHATBOT_FEED_STORE,
  ChatbotFeedService,
  FEED_CLOCK,
  FEED_WAKEUP,
} from './application/chatbot-feed.service';
import {
  CHATBOT_RECOVERY_STORE,
  ChatbotRecoveryService,
} from './application/chatbot-recovery.service';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import {
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
import {
  BOT_INTAKE_STORE,
  BotRequestIntakeService,
  LEGACY_INTAKE,
} from './application/bot-request-intake.service';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
} from './application/chatbot-request-reads.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestWrapperModule } from './chatbot-request-wrapper.module';
import { WrappedRequestResolutionModule } from './wrapped-request-resolution.module';
import { ChatbotFeedPurgeScheduler } from './infrastructure/chatbot-feed-purge.scheduler';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import { LegacyIntakeAdapter } from './infrastructure/legacy-intake.adapter';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WrappedRequestResolutionModule,
    ChatbotApiModule,
    ChatbotRequestWrapperModule,
    DeliveryZonesModule,
    RealtimeModule,
  ],
  controllers: [
    ChatbotRequestCommandsController,
    ChatbotRequestRelationsController,
    ChatbotRequestReadsController,
    BotRequestsController,
    BotFeedController,
    BotRecoveryController,
  ],
  providers: [
    ActiveUserGuard,
    ChatbotRequestHttpFilter,
    ChatbotRequestCommandsService,
    ChatbotRequestRelationsService,
    {
      provide: CHATBOT_REQUEST_RELATION_STORE,
      useClass: PrismaChatbotRequestRelationStore,
    },
    ChatbotRequestReadsService,
    {
      provide: CHATBOT_REQUEST_READ_STORE,
      useClass: PrismaChatbotRequestReadStore,
    },
    {
      // R12: staff responses never carry the raw customerKey (it is the phone).
      provide: CUSTOMER_KEY_SEALER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CustomerKeySealer(config.getOrThrow<string>('JWT_SECRET')),
    },
    { provide: INBOX_CLOCK, useValue: () => new Date() },
    BotRequestIntakeService,
    ChatbotFeedService,
    ChatbotRecoveryService,
    PgFeedWakeup,
    ChatbotFeedPurgeScheduler,
    { provide: FEED_WAKEUP, useExisting: PgFeedWakeup },
    { provide: CHATBOT_FEED_STORE, useClass: PrismaChatbotFeedStore },
    { provide: CHATBOT_RECOVERY_STORE, useClass: PrismaChatbotRecoveryStore },
    { provide: FEED_CLOCK, useValue: Date.now },
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
