/**
 * PdfGenerationModule — wiring tests.
 *
 * These assertions are *compile + reflect* checks, not runtime boots. The
 * pattern mirrors `src/sales/sales.module.spec.ts` (and the rest of the
 * codebase): we read `MODULE_METADATA` off the class so we don't have to
 * instantiate the full DI graph (SalesModule, TenantsModule, OutboxModule,
 * etc.) just to assert "service is registered".
 *
 * Why reflect-metadata instead of `Test.createTestingModule`?
 *   - The PDF generation module is a *consumer* of SalesModule and
 *     TenantsModule. Booting those would pull in Prisma, AuthModule, etc.
 *   - For module-shape tests, we just need to prove the module is wired
 *     correctly so a future runtime boot (in WU5 integration tests)
 *     won't fail with "PdfGenerationController provider not registered".
 *   - `Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ModuleClass)` is the
 *     idiomatic lightweight check used throughout this repo.
 *
 * WU4 update: the module now declares `PdfGenerationController`. The
 * spec reflects that change — controllers are no longer empty.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PdfGenerationModule } from './pdf-generation.module';
import { PdfGenerationController } from './pdf-generation.controller';
import { PdfGenerationService } from './pdf-generation.service';
import { SalesModule } from '../sales/sales.module';
import { TenantsModule } from '../tenants/tenants.module';

describe('PdfGenerationModule', () => {
  it('registers PdfGenerationService as a provider', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PdfGenerationModule,
    ) as unknown[];

    expect(providers).toContain(PdfGenerationService);
  });

  it('imports SalesModule so PdfGenerationService can consume SalesService', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PdfGenerationModule,
    ) as unknown[];

    expect(imports).toContain(SalesModule);
  });

  it('imports TenantsModule so PdfGenerationService can read branch address/phone', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PdfGenerationModule,
    ) as unknown[];

    expect(imports).toContain(TenantsModule);
  });

  it('registers PdfGenerationController for GET /sales/:id/pdf', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PdfGenerationModule,
    ) as unknown[] | undefined;

    // WU4 ships the controller — GET /sales/:id/pdf guarded by the
    // standard JwtAuthGuard + TenantContextGuard + PermissionsGuard stack.
    expect(controllers ?? []).toContain(PdfGenerationController);
  });

  it('does not export PdfGenerationService (consumed internally only)', () => {
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PdfGenerationModule,
    ) as unknown[] | undefined;

    // Nothing else in the app needs PdfGenerationService yet. If a future
    // caller needs it, exporting should be a deliberate decision, not an
    // accident of the foundation commit.
    expect(exports ?? []).toEqual([]);
  });
});
