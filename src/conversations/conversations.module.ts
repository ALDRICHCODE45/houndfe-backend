/**
 * ConversationsModule — the conversation mirror and its media (human-
 * intervention unit 9; contract §3.6, §3.9, §6.2, §12.5):
 *
 *   bot    POST /chatbot-api/conversations/:ref/messages:batch
 *          POST /chatbot-api/messages/statuses:batch
 *          POST /chatbot-api/media
 *   staff  GET  /chatbot-requests/:id/conversation
 *          GET  /chatbot-media/:id
 *   retention: hourly `@Interval` purge of messages, files and emptied chats,
 *   plus the S2 reconciliation of media intents and the bucket orphan sweep.
 *
 * Files go to Spaces with a PRIVATE ACL through the receipts adapter (the same
 * `SPACES_*` client; `RECEIPTS_SPACES_BUCKET` or `SPACES_BUCKET`) under the
 * `conversation-media/` prefix: no new adapter and no second bucket setting.
 * `ChatbotApiModule` supplies the bot guard's credential repository, `AuthModule`
 * the staff guards; the realtime events go to the unit 8 log from the store.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { createSpacesClient } from '../files/infrastructure/spaces-client.factory';
import { SpacesReceiptStorageAdapter } from '../receipts/infrastructure/spaces-receipt-storage.adapter';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import {
  CONVERSATION_MEDIA_STORAGE,
  CONVERSATION_MEDIA_STORE,
  ConversationMediaService,
} from './application/conversation-media.service';
import {
  CONVERSATION_MIRROR_STORE,
  ConversationMirrorService,
} from './application/conversation-mirror.service';
import {
  CONVERSATION_READ_STORE,
  ConversationReadsService,
} from './application/conversation-reads.service';
import { ConversationRetentionService } from './application/conversation-retention.service';
import { ConversationRetentionScheduler } from './infrastructure/conversation-retention.scheduler';
import { CONVERSATION_MEDIA_LISTER } from './application/conversation-media-lister';
import { SpacesConversationMediaLister } from './infrastructure/spaces-conversation-media.lister';
import { PrismaConversationMediaStore } from './infrastructure/prisma-conversation-media.store';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from './infrastructure/prisma-conversation-read.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { BotMediaController } from './presentation/bot-media.controller';
import { ConversationMediaController } from './presentation/conversation-media.controller';
import { ConversationReadsController } from './presentation/conversation-reads.controller';
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';

@Module({
  imports: [DatabaseModule, AuthModule, ChatbotApiModule],
  controllers: [
    BotConversationController,
    BotMediaController,
    ConversationReadsController,
    ConversationMediaController,
  ],
  providers: [
    ActiveUserGuard,
    ChatbotRequestHttpFilter,
    ConversationMirrorService,
    ConversationReadsService,
    ConversationMediaService,
    ConversationRetentionService,
    // §3.6, §10.1: hourly, bounded, SKIP LOCKED (found by AppModule's ScheduleModule).
    ConversationRetentionScheduler,
    {
      provide: CONVERSATION_MIRROR_STORE,
      useClass: PrismaConversationMirrorStore,
    },
    { provide: CONVERSATION_READ_STORE, useClass: PrismaConversationReadStore },
    {
      provide: CONVERSATION_MEDIA_STORE,
      useClass: PrismaConversationMediaStore,
    },
    // S2: read-only listing of the same bucket for the orphan sweep.
    {
      provide: CONVERSATION_MEDIA_LISTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new SpacesConversationMediaLister(
          createSpacesClient(config),
          config.get<string>('RECEIPTS_SPACES_BUCKET') ||
            config.getOrThrow<string>('SPACES_BUCKET'),
        ),
    },
    {
      provide: CONVERSATION_MEDIA_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new SpacesReceiptStorageAdapter(
          createSpacesClient(config),
          config.get<string>('RECEIPTS_SPACES_BUCKET') ||
            config.getOrThrow<string>('SPACES_BUCKET'),
        ),
    },
  ],
})
export class ConversationsModule {}
