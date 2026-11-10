/**
 * Chatbot request inbox (human-intervention unit 2): staff commands claim,
 * release, reassign and cancel. `AuthModule` provides `JwtAuthGuard` and
 * `PermissionsGuard`; `ActiveUserGuard` resolves `PrismaService` from the
 * global `DatabaseModule`.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ChatbotRequestCommandsController],
  providers: [
    ActiveUserGuard,
    ChatbotRequestHttpFilter,
    ChatbotRequestCommandsService,
    {
      provide: CHATBOT_REQUEST_COMMAND_STORE,
      useClass: PrismaChatbotRequestCommandStore,
    },
  ],
})
export class ChatbotRequestsModule {}
