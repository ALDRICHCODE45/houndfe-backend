/**
 * CatalogSettingsModule — wiring tests (online-catalog-publishing / WU3A3c).
 *
 * Compile + reflect checks, not runtime boots. The pattern mirrors
 * `src/pdf-generation/pdf-generation.module.spec.ts`: we read
 * `MODULE_METADATA` off the class so we don't have to instantiate the full
 * DI graph (AuthModule pulls ConfigService-backed JWT async registration)
 * just to assert "controller / use case / repository adapter are wired".
 *
 * Why reflect-metadata instead of `Test.createTestingModule`?
 *   - CatalogSettingsModule imports AuthModule, whose JwtModule.registerAsync
 *     factory calls `ConfigService.getOrThrow('JWT_SECRET')` at
 *     instantiation — a boot-level concern, not a wiring concern.
 *   - For a module-shape test we only need to prove the metadata is wired so
 *     a runtime boot won't fail with "provider not registered".
 *
 * AppModule registration is deliberately NOT asserted here: importing
 * AppModule in a jest spec is a known-broken path in this repo —
 * `src/orders/listeners/order-event.listener.ts` uses a `src/...` import
 * style with no tsconfig paths / jest moduleNameMapper mapping (documented
 * in `src/shared/config/app-module-boot.spec.ts`). The exactly-once
 * AppModule registration is verified by diff review in the work unit.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { CatalogSettingsModule } from './catalog-settings.module';
import { CatalogSettingsController } from './presentation/catalog-settings.controller';
import { GetCatalogSettingsUseCase } from './application/get-catalog-settings.use-case';
import { PrismaCatalogSettingsRepository } from './infrastructure/prisma-catalog-settings.repository';
import { CATALOG_SETTINGS_REPOSITORY } from './domain/catalog-settings.repository';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

describe('CatalogSettingsModule', () => {
  it('registers CatalogSettingsController', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      CatalogSettingsModule,
    ) as unknown[] | undefined;

    expect(controllers ?? []).toContain(CatalogSettingsController);
  });

  it('registers GetCatalogSettingsUseCase as a provider', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      CatalogSettingsModule,
    ) as unknown[];

    expect(providers).toContain(GetCatalogSettingsUseCase);
  });

  it('binds CATALOG_SETTINGS_REPOSITORY to PrismaCatalogSettingsRepository', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      CatalogSettingsModule,
    ) as Array<{ provide?: unknown; useClass?: unknown }>;

    const repoProvider = providers.find(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        'provide' in p &&
        p.provide === CATALOG_SETTINGS_REPOSITORY,
    );

    expect(repoProvider).toBeDefined();
    expect(repoProvider?.useClass).toBe(PrismaCatalogSettingsRepository);
  });

  it('imports DatabaseModule so the Prisma adapter resolves TenantPrismaService', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      CatalogSettingsModule,
    ) as unknown[];

    expect(imports).toContain(DatabaseModule);
  });

  it('imports AuthModule for the controller guard stack', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      CatalogSettingsModule,
    ) as unknown[];

    expect(imports).toContain(AuthModule);
  });
});
