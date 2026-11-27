/**
 * PdfGenerationModule — dedicated module for PDF generation.
 *
 * Why a dedicated module (not a controller on `SalesQueryController`)?
 * Per the design:
 *   - Template registry is cross-cutting (future invoice-a4,
 *     report-a4, quote-a4) — not a sales concern.
 *   - DDD bounded-context separation: sales owns sales data;
 *     pdf-generation owns rendering. SalesService is consumed
 *     via DI; no coupling to sales internals.
 *
 * Imports:
 *   - `SalesModule` — exposes `SalesService.getSaleDetail()` so the
 *     PDF service can fetch the sale + line items + payments.
 *   - `TenantsModule` — exports tenant primitives via `TENANT_REPOSITORY`
 *     so the PDF service can pull branch address + phone for the
 *     receipt header (per the design's "branding from constants +
 *     Tenant model, no DB migration" decision).
 *
 * Providers:
 *   - `PdfGenerationService` — render orchestrator + `OnModuleInit`
 *     font registration + format/status/error mapping.
 *
 * Controllers:
 *   - `PdfGenerationController` — `GET /sales/:id/pdf` (sale) +
 *     `GET /quotations/:id/pdf` (quotation, WU4) with the standard
 *     auth stack (`JwtAuthGuard` → `TenantContextGuard`
 *     → `PermissionsGuard`).
 *
 * Exports:
 *   - `PdfGenerationService` (WU4) — consumed by `QuotationsService`
 *     to render the PDF in-memory during the `send()` atomic flow.
 *     The controller consumes `QuotationsService` directly for the
 *     preview route; both seams share the same render method.
 */
import { Module } from '@nestjs/common';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import {
  CashClosingPdfController,
  CashClosingPdfService,
} from './cash-closing';
import { AuthModule } from '../auth/auth.module';
import { SalesModule } from '../sales/sales.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PdfGenerationController } from './pdf-generation.controller';
import { PdfGenerationService } from './pdf-generation.service';
import { SalesCustomerStatementController } from '../sales/sales-customer-statement.controller';
import { CollectionReceiptPdfController } from '../sales/collection-receipt-pdf.controller';
import { CustomersModule } from '../customers/customers.module';
import { CustomerBulkStatementsController } from '../sales/customer-bulk-statements.controller';
import { CustomerBulkStatementsService } from '../sales/customer-bulk-statements.service';
import { CustomerBulkStatementsRunGuard } from '../sales/customer-bulk-statements.busy-guard';

@Module({
  // customers-bulk-actions / T3 — CustomersModule exports the bulk selection
  // resolver; it imports only AuthModule, so no module cycle.
  imports: [
    AuthModule,
    SalesModule,
    TenantsModule,
    CashRegisterModule,
    CustomersModule,
  ],
  providers: [
    PdfGenerationService,
    CashClosingPdfService,
    // customers-bulk-actions / T3 — `POST /customers/bulk/statements`; the
    // run guard is a singleton: one bulk statements run per process.
    CustomerBulkStatementsService,
    CustomerBulkStatementsRunGuard,
  ],
  // sales-history-redesign S11 — `GET /customers/:customerId/statement/pdf`
  // lives in src/sales but is registered here: this module already imports
  // SalesModule (which exports CustomerStatementService), so no module cycle.
  // customer-collection / T3 — `GET /collections/:collectionId/pdf`, same
  // pattern (SalesModule exports CollectionReadService).
  // customers-bulk-actions / T3 — `POST /customers/bulk/statements`, same
  // pattern (+ CustomersModule for the selection resolver).
  controllers: [
    PdfGenerationController,
    CashClosingPdfController,
    SalesCustomerStatementController,
    CollectionReceiptPdfController,
    CustomerBulkStatementsController,
  ],
  exports: [PdfGenerationService],
})
export class PdfGenerationModule {}
