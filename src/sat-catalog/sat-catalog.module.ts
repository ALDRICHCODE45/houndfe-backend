/**
 * SatCatalogModule — NestJS module for the sat-catalog bounded context.
 *
 * Hexagonal wiring (mirrors `src/products/products.module.ts:22-33`):
 *   - Imports `DatabaseModule` (= `PrismaModule`) for the base
 *     `PrismaService` (the catalog is non-tenant reference data — NOT in
 *     `TENANT_SCOPED_MODELS`).
 *   - Imports `AuthModule` for `JwtAuthGuard` / `TenantContextGuard` /
 *     `PermissionsGuard` references used by the controller's
 *     `@UseGuards(...)` metadata.
 *   - Providers bind `SAT_KEY_REPOSITORY` → `PrismaSatKeyRepository` and
 *     expose `SatCatalogService`.
 *   - Exports `SatCatalogService` — Slice D's `ProductsModule` will
 *     import this module and inject the service into `ProductsService`.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SatCatalogController } from './sat-catalog.controller';
import { SatCatalogService } from './sat-catalog.service';
import { PrismaSatKeyRepository } from './infrastructure/prisma-sat-key.repository';
import { SAT_KEY_REPOSITORY } from './domain/sat-key.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SatCatalogController],
  providers: [
    SatCatalogService,
    {
      provide: SAT_KEY_REPOSITORY,
      useClass: PrismaSatKeyRepository,
    },
  ],
  exports: [SatCatalogService],
})
export class SatCatalogModule {}
