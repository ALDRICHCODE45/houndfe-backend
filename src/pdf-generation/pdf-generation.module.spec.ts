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
 * WU4 update: the module declares `PdfGenerationController` (sale +
 * quotation routes). WU4 also exports `PdfGenerationService` so the
 * `QuotationsModule`'s `send()` flow can render the PDF in-memory
 * without a circular import.
 */
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PdfGenerationModule } from './pdf-generation.module';
import { PdfGenerationController } from './pdf-generation.controller';
import { PdfGenerationService } from './pdf-generation.service';
import { SalesModule } from '../sales/sales.module';
import { TenantsModule } from '../tenants/tenants.module';
import { SalesCustomerStatementController } from '../sales/sales-customer-statement.controller';
import { CustomerStatementService } from '../sales/customer-statement.service';

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

  it('registers PdfGenerationController for GET /sales/:id/pdf + GET /quotations/:id/pdf (WU4)', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PdfGenerationModule,
    ) as unknown[] | undefined;

    // WU4 ships the controller for both sale + quotation routes,
    // guarded by the standard JwtAuthGuard + TenantContextGuard +
    // PermissionsGuard stack.
    expect(controllers ?? []).toContain(PdfGenerationController);
  });

  it('exports PdfGenerationService for cross-module render (WU4)', () => {
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PdfGenerationModule,
    ) as unknown[] | undefined;

    // WU4 — QuotationsService.send() calls renderQuotationPdfToBuffer
    // inside PdfGenerationService. The export is a deliberate seam
    // for the send-time render; the existing in-module caller
    // (PdfGenerationController) still resolves via DI without
    // touching the export list.
    expect(exports ?? []).toContain(PdfGenerationService);
  });

  // sales-history-redesign S11 — GET /customers/:customerId/statement/pdf.
  // PdfGenerationModule already imports SalesModule, so the statement route
  // is registered HERE (one place) and SalesModule never imports this module.
  describe('customer statement PDF route (S11)', () => {
    const controllersOf = (module: object) =>
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ??
        []) as unknown[];

    it('maps the statement controller exactly once, here and not in SalesModule', () => {
      const all = [
        ...controllersOf(PdfGenerationModule),
        ...controllersOf(SalesModule),
      ];

      expect(
        all.filter((c) => c === SalesCustomerStatementController),
      ).toHaveLength(1);
      expect(controllersOf(PdfGenerationModule)).toContain(
        SalesCustomerStatementController,
      );
      expect(controllersOf(SalesModule)).not.toContain(
        SalesCustomerStatementController,
      );
      expect(
        Reflect.getMetadata(PATH_METADATA, SalesCustomerStatementController),
      ).toBe('customers/:customerId/statement/pdf');
    });

    it('SalesModule exports the statement service and never imports PdfGenerationModule (no forwardRef cycle)', () => {
      const salesImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        SalesModule,
      ) ?? []) as unknown[];
      const salesExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        SalesModule,
      ) ?? []) as unknown[];

      expect(salesImports).not.toContain(PdfGenerationModule);
      for (const entry of salesImports) {
        // forwardRef(() => X) entries are objects with a `forwardRef` thunk.
        expect(entry).toBeDefined();
        expect(
          typeof entry === 'object' && entry !== null && 'forwardRef' in entry,
        ).toBe(false);
      }
      expect(salesExports).toContain(CustomerStatementService);
    });
  });
});
