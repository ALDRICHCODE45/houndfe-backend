/**
 * Leaf module with the wrapper hook the legacy flows call (unit 3). It imports
 * nothing but the global database module, so RESTOCK/EXPIRATION, delivery
 * zones, receipts and sales can all import it without a cycle with
 * `ChatbotRequestsModule` (which imports them to resolve).
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';

@Module({
  imports: [DatabaseModule],
  providers: [ChatbotRequestWrapper],
  exports: [ChatbotRequestWrapper],
})
export class ChatbotRequestWrapperModule {}
