/**
 * NotificationConfigModule — NestJS module for the notification-config
 * bounded context.
 *
 * Hexagonal wiring (mirrors `src/sat-catalog/sat-catalog.module.ts` and
 * the slice plan in `openspec/changes/low-stock-alerts/design.md`):
 *   - Imports `DatabaseModule` (global Prisma) for the tenant-scoped client
 *     used by the adapter (`TenantPrismaService`).
 *   - Imports `AuthModule` for `JwtAuthGuard`, `TenantContextGuard`,
 *     `PermissionsGuard`, and `CaslAbilityFactory` referenced by the
 *     controller's `@UseGuards(...)` and `@RequirePermissions(...)`
 *     decorators.
 *   - Providers bind `NOTIFICATION_CONFIG_REPOSITORY` →
 *     `PrismaNotificationConfigRepository` and expose
 *     `NotificationConfigService`.
 *   - Exports `NotificationConfigService` so future slices (E/F —
 *     stock-alerts / Inngest functions) can inject it.
 *
 * Registered in `src/app.module.ts` like every other feature module
 * (`SatCatalogModule`, `CategoriesModule`, etc.).
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationConfigController } from './notification-config.controller';
import { NotificationConfigService } from './notification-config.service';
import { PrismaNotificationConfigRepository } from './infrastructure/prisma-notification-config.repository';
import { NOTIFICATION_CONFIG_REPOSITORY } from './domain/notification-config.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [NotificationConfigController],
  providers: [
    NotificationConfigService,
    {
      provide: NOTIFICATION_CONFIG_REPOSITORY,
      useClass: PrismaNotificationConfigRepository,
    },
  ],
  exports: [NotificationConfigService],
})
export class NotificationConfigModule {}