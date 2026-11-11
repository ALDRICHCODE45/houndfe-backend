/**
 * ChatbotRequestNoticeOutboxModule — the durable pipeline of the request
 * notices (R3): the notify consumer and the email dispatcher. Registered only
 * in app.module.ts, in the same change that makes the generic poller exclude
 * `RESERVED_OUTBOX_PREFIX`, so every row under it has exactly one owner. Own
 * module so the Inngest dependency graph stays out of other chains.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { InngestModule } from '../../inngest/inngest.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import {
  NOTIFICATION_EVENTS,
  noopNotificationEvents,
} from '../domain/notification-events.port';
import { NOTICE_EMAIL_LOADER } from '../inngest/chatbot-request-email.functions';
import { PrismaNoticeEmailLoader } from '../infrastructure/prisma-notice-email.loader';
import {
  ChatbotRequestEmailDispatcher,
  NOTICE_EMAIL_BATCH_SIZE,
  NOTICE_EMAIL_LOCK_MS,
  NOTICE_EMAIL_MAX_RETRIES,
} from './chatbot-request-email.dispatcher';
import {
  ChatbotRequestNotifyConsumer,
  NOTICE_CLOCK,
  NOTICE_NOTIFY_BATCH_SIZE,
  NOTICE_NOTIFY_MAX_RETRIES,
} from './chatbot-request-notify.consumer';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    InngestModule,
  ],
  providers: [
    ChatbotRequestNotifyConsumer,
    ChatbotRequestEmailDispatcher,
    PrismaNoticeEmailLoader,
    { provide: NOTICE_EMAIL_LOADER, useExisting: PrismaNoticeEmailLoader },
    // Unit 8 replaces this with the publisher that writes the RealtimeEvent.
    { provide: NOTIFICATION_EVENTS, useValue: noopNotificationEvents },
    { provide: NOTICE_CLOCK, useValue: () => new Date() },
    {
      provide: NOTICE_NOTIFY_BATCH_SIZE,
      useValue: Number(process.env.NOTICE_NOTIFY_BATCH_SIZE ?? 25),
    },
    {
      provide: NOTICE_NOTIFY_MAX_RETRIES,
      useValue: Number(process.env.NOTICE_NOTIFY_MAX_RETRIES ?? 5),
    },
    {
      provide: NOTICE_EMAIL_BATCH_SIZE,
      useValue: Number(process.env.NOTICE_EMAIL_BATCH_SIZE ?? 100),
    },
    {
      provide: NOTICE_EMAIL_LOCK_MS,
      useValue: Number(process.env.NOTICE_EMAIL_LOCK_MS ?? 60_000),
    },
    {
      provide: NOTICE_EMAIL_MAX_RETRIES,
      useValue: Number(process.env.NOTICE_EMAIL_MAX_RETRIES ?? 5),
    },
  ],
  exports: [
    ChatbotRequestNotifyConsumer,
    ChatbotRequestEmailDispatcher,
    NOTICE_EMAIL_LOADER,
  ],
})
export class ChatbotRequestNoticeOutboxModule {}
