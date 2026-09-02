/**
 * CatalogSettingsModule — NestJS module for the catalog-settings bounded
 * context (online-catalog-publishing / WU3A3c).
 *
 * Hexagonal wiring (mirrors `src/sat-catalog/sat-catalog.module.ts` and
 * `src/notification-config/notification-config.module.ts`):
 *   - Imports `DatabaseModule` (global Prisma) for the tenant-scoped client
 *     used by the adapter (`TenantPrismaService`).
 *   - Imports `AuthModule` for `JwtAuthGuard`, `TenantContextGuard`, and
 *     `PermissionsGuard` referenced by the controller's `@UseGuards(...)`
 *     metadata (`CaslAbilityFactory` is injected by `PermissionsGuard`).
 *   - Providers expose `GetCatalogSettingsUseCase` and
 *     `UpdateCatalogSettingsUseCase`, the WU3B3 audit listener
 *     (`CatalogSettingsEventListener`, global `EventEmitterModule`), and bind
 *     the `CATALOG_SETTINGS_REPOSITORY` port to
 *     `PrismaCatalogSettingsRepository`.
 *
 * Registered exactly once in `src/app.module.ts` like every other feature
 * module.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CatalogSettingsController } from './presentation/catalog-settings.controller';
import { GetCatalogSettingsUseCase } from './application/get-catalog-settings.use-case';
import { UpdateCatalogSettingsUseCase } from './application/update-catalog-settings.use-case';
import { CatalogSettingsEventListener } from './listeners/catalog-settings-event.listener';
import { PrismaCatalogSettingsRepository } from './infrastructure/prisma-catalog-settings.repository';
import { CATALOG_SETTINGS_REPOSITORY } from './domain/catalog-settings.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [CatalogSettingsController],
  providers: [
    GetCatalogSettingsUseCase,
    UpdateCatalogSettingsUseCase,
    CatalogSettingsEventListener,
    {
      provide: CATALOG_SETTINGS_REPOSITORY,
      useClass: PrismaCatalogSettingsRepository,
    },
  ],
})
export class CatalogSettingsModule {}
