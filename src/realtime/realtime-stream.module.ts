/**
 * RealtimeStreamModule — `GET /realtime/stream` (human-intervention unit 8;
 * contract §5.3, §10.1 R5/R6/R7/R12): the durable log's reads and retention,
 * the per-replica hub, the per-recipient shaper, the access re-check and the
 * HTTP route. It reuses the replica's single `LISTEN` connection from the
 * shared `RealtimeModule` (R7), and the rows are built by the inbox reads
 * service (`ChatbotRequestsModule`) and the notifications service, so the
 * stream shows exactly what the REST routes show.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { ChatbotRequestsModule } from '../chatbot-requests/chatbot-requests.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PgNotificationListener } from '../shared/realtime/pg-notification-listener';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import { TenantModule } from '../shared/tenant/tenant.module';
import { REALTIME_NOTIFICATION_READER } from './application/notification-event-reader';
import { AccessGate, REALTIME_ACCESS } from './application/realtime-access';
import { RealtimeEventShaper } from './application/realtime-event-shaper';
import {
  REALTIME_LISTENER,
  REALTIME_SHAPER,
  REALTIME_STORE,
  RealtimeHub,
} from './application/realtime-hub.service';
import { PrismaNotificationEventReader } from './infrastructure/prisma-notification-event.reader';
import { PrismaRealtimeAccess } from './infrastructure/prisma-realtime-access';
import { PrismaRealtimeEventStore } from './infrastructure/prisma-realtime-event.store';
import { RealtimeRetentionScheduler } from './infrastructure/realtime-retention.scheduler';
import { RealtimeController } from './presentation/realtime.controller';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    TenantModule,
    RealtimeModule,
    ChatbotRequestsModule,
    NotificationsModule,
  ],
  controllers: [RealtimeController],
  providers: [
    ActiveUserGuard,
    PrismaRealtimeEventStore,
    PrismaRealtimeAccess,
    PrismaNotificationEventReader,
    RealtimeEventShaper,
    RealtimeHub,
    // 24 h retention, bounded, SKIP LOCKED (found by AppModule's ScheduleModule).
    RealtimeRetentionScheduler,
    {
      provide: REALTIME_NOTIFICATION_READER,
      useExisting: PrismaNotificationEventReader,
    },
    { provide: REALTIME_LISTENER, useExisting: PgNotificationListener },
    { provide: REALTIME_STORE, useExisting: PrismaRealtimeEventStore },
    { provide: REALTIME_SHAPER, useExisting: RealtimeEventShaper },
    {
      provide: REALTIME_ACCESS,
      inject: [PrismaRealtimeAccess],
      useFactory: (source: PrismaRealtimeAccess) => new AccessGate(source),
    },
  ],
})
export class RealtimeStreamModule {}
