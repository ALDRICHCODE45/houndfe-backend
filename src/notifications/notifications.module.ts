/**
 * NotificationsModule — the API of the signed-in person's notifications
 * (contract §5.2). Separate from `NotificationConfigModule` (R8): it does not
 * depend on `NotificationSettings`. `AuthModule` provides `JwtAuthGuard`;
 * `DatabaseModule` provides the tenant and root Prisma services.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { NotificationsService } from './application/notifications.service';
import { NOTIFICATION_READ_EVENTS } from './domain/notification-events.port';
import { RealtimeNotificationEvents } from './infrastructure/realtime-notification-events';
import { NotificationRetentionScheduler } from './infrastructure/notification-retention.scheduler';
import { PrismaNotificationRetentionStore } from './infrastructure/prisma-notification-retention.store';
import { NotificationPreferencesController } from './presentation/notification-preferences.controller';
import { NotificationsController } from './presentation/notifications.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [
    ActiveUserGuard,
    NotificationsService,
    // Unit 8: read / read-all announce `notification.read` in their transaction.
    RealtimeNotificationEvents,
    {
      provide: NOTIFICATION_READ_EVENTS,
      useExisting: RealtimeNotificationEvents,
    },
    // §5.2: 90-day retention, bounded batches, SKIP LOCKED (unit 7b). The
    // `@Interval` is discovered through AppModule's ScheduleModule.forRoot().
    PrismaNotificationRetentionStore,
    NotificationRetentionScheduler,
  ],
  // The realtime stream (unit 8) builds `notification.created` payloads.
  exports: [NotificationsService],
})
export class NotificationsModule {}
