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
 *   - For a skeleton (WU1), we just need to prove the module is shape-correct
 *     so a future runtime boot (in WU5 integration tests) won't fail with
 *     "PdfGenerationService provider not registered".
 *   - `Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ModuleClass)` is the
 *     idiomatic lightweight check used throughout this repo.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PdfGenerationModule } from './pdf-generation.module';
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

  it('does not register any controllers in WU1 (controller arrives in WU4)', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PdfGenerationModule,
    ) as unknown[] | undefined;

    // WU1 ships a skeleton only. The PDF endpoint controller lands in WU4.
    expect(controllers ?? []).toEqual([]);
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
