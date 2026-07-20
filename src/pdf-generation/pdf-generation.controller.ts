/**
 * PdfGenerationController — HTTP adapter for `GET /sales/:id/pdf`.
 *
 * Single endpoint: streams a branded PDF receipt for a confirmed
 * sale in either A4 or thermal-ticket format. All rendering logic
 * lives in `PdfGenerationService`; this file is the thin HTTP seam.
 *
 * Why a dedicated controller (not a route on `SalesQueryController`)?
 *   - PDF generation is a cross-cutting concern. Future endpoints
 *     (invoice, quote, report) will land here too — they share the
 *     same render pipeline but have nothing to do with sales CRUD.
 *   - The existing sales controllers stay focused on draft + charge
 *     mutation; PDF is read-only and benefits from its own guard +
 *     permission set.
 *
 * Auth stack (matches the rest of the codebase):
 *   `JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`
 * with `@RequirePermissions(['read', 'Sale'])` enforcing the FE
 * contract: a user who can read a sale can also render its PDF.
 *
 * Error mapping: we let NestJS exception filter handle the rest.
 *   - `BadRequestException('INVALID_FORMAT')` → 400 (caught at the
 *     controller boundary before the DB roundtrip).
 *   - `NotFoundException` (service) → 404.
 *   - `BadRequestException('SALE_NOT_CONFIRMED')` (service) → 400.
 *   - `InternalServerErrorException('PDF_GENERATION_FAILED')` (service) → 500.
 *
 * Streaming: `res.send(stream)` lets Nest/Express pipe the readable
 * straight to the socket. We do NOT call `res.send` with a buffered
 * PDF — the spec mandates streaming (≤50 line items within 2s).
 */
import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { PdfGenerationService } from './pdf-generation.service';

/**
 * WU4 — single endpoint.
 *
 * Path: `GET /sales/:id/pdf?format={receipt-a4|receipt-ticket}`
 *
 * The path is nested under `sales` (not `pdf-generation`) because
 * the receipt is conceptually a derived view of a sale — the FE
 * already navigates `/sales/:id/...` for the detail/charge flows,
 * so `/sales/:id/pdf` matches that mental model.
 */
@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PdfGenerationController {
  constructor(private readonly pdfService: PdfGenerationService) {}

  @Get(':id/pdf')
  @RequirePermissions(['read', 'Sale'])
  async generatePdf(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    // Resolve format FIRST so invalid format short-circuits before
    // we hit the DB. The service throws BadRequestException on
    // unknown keys — the filter maps it to 400 INVALID_FORMAT.
    const resolvedFormat = this.pdfService.resolveFormat(format);

    // Tenant isolation: the user object is the JWT-derived context
    // populated by JwtAuthGuard + TenantContextGuard. Cross-tenant
    // access is impossible here because the JWT carries the tenant
    // claim and `SalesService.getSaleDetail` enforces it again.
    const tenantId = user.tenantId;
    if (!tenantId) {
      // Defense-in-depth — TenantContextGuard already rejects
      // requests without tenantId, so this branch is unreachable
      // in practice. We keep it so a future misconfiguration of
      // the guard stack doesn't silently leak data across tenants.
      throw new Error('TENANT_CONTEXT_REQUIRED');
    }

    const { stream, folio } = await this.pdfService.generateSalePdf(
      id,
      tenantId,
      resolvedFormat,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': this.buildContentDisposition(folio),
    });
    // WU5 — pipe the Node Readable to the response stream instead of
    // `res.send(stream)`. Express's `res.send(stream)` historically
    // pipes Node Streams, but the version of Express bundled with
    // @nestjs/platform-express@11.x serializes Readable objects as
    // JSON when it can't detect them as a legacy Node Stream (the
    // underlying `instanceof Stream` check uses `node:stream` and
    // misses `Readable.from(...)` instances in some Node versions).
    // Piping explicitly avoids the JSON serialization footgun and
    // works identically across Node 18 / 20 / 22.
    stream.pipe(res);
  }

  /**
   * Build the download filename. Spec mandates
   * `attachment; filename="recibo-{folio}.pdf"`. The folio is
   * already on the service's return tuple (no extra DB roundtrip
   * — it comes from `SalesService.getSaleDetail` which the service
   * already called to validate the sale). We sanitize to a safe
   * filename charset because some folios (e.g. legacy imports) can
   * contain `/` or other path-unsafe characters.
   */
  private buildContentDisposition(folio: string): string {
    const safeFolio = folio.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    return `attachment; filename="recibo-${safeFolio}.pdf"`;
  }
}
