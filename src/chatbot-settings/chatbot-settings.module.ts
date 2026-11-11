/**
 * Chatbot attention settings (human-intervention unit 7a). `AuthModule`
 * provides the JWT and permission guards; `PrismaService` comes from the
 * global `DatabaseModule`.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import {
  ChatbotSettingsService,
  SETTINGS_CLOCK,
} from './application/chatbot-settings.service';
import { ChatbotSettingsController } from './presentation/chatbot-settings.controller';
import { ChatbotSettingsHttpFilter } from './presentation/chatbot-settings.filter';

@Module({
  imports: [AuthModule],
  controllers: [ChatbotSettingsController],
  providers: [
    ActiveUserGuard,
    ChatbotSettingsHttpFilter,
    ChatbotSettingsService,
    { provide: SETTINGS_CLOCK, useValue: () => new Date() },
  ],
})
export class ChatbotSettingsModule {}
