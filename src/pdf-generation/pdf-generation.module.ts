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
 *   - `TenantsModule` — exposes `TenantsService.findById()` so the
 *     PDF service can pull branch address + phone for the receipt
 *     header (per the design's "branding from constants + Tenant
 *     model, no DB migration" decision).
 *
 * Providers:
 *   - `PdfGenerationService` — WU1 stub. Render orchestration,
 *     `OnModuleInit` font registration, error mapping arrive in WU4.
 *
 * Controllers:
 *   - None in WU1. `GET /sales/:id/pdf` lands in WU4 with its guards
 *     (`JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`).
 *
 * Exports:
 *   - None. The service is consumed internally by the module's own
 *     controller. If a future caller needs the service, exporting
 *     should be a deliberate decision, not implicit.
 */
import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PdfGenerationService } from './pdf-generation.service';

@Module({
  imports: [SalesModule, TenantsModule],
  providers: [PdfGenerationService],
  controllers: [],
  exports: [],
})
export class PdfGenerationModule {}
