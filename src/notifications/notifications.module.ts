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
import { NotificationPreferencesController } from './presentation/notification-preferences.controller';
import { NotificationsController } from './presentation/notifications.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [ActiveUserGuard, NotificationsService],
})
export class NotificationsModule {}
