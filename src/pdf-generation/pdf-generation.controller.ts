/**
 * PdfGenerationController — HTTP adapter for `GET /sales/:id/pdf` and
 * `GET /quotations/:id/pdf` (WU4).
 *
 * Single controller handles both sale and quotation PDF routes so
 * the template registry + render pipeline stays in one place.
 *
 * Auth stack (matches the rest of the codebase):
 *   `JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`
 * with `@RequirePermissions(['read', 'Sale'])` (or `... Quotation`
 * for the new route) enforcing the FE contract: a user who can read
 * the underlying record can also render its PDF.
 *
 * Error mapping: we let NestJS exception filter handle the rest.
 *   - `BadRequestException('INVALID_FORMAT')` → 400 (caught at the
 *     controller boundary before the DB roundtrip).
 *   - `NotFoundException` (service) → 404.
 *   - `InternalServerErrorException('PDF_GENERATION_FAILED')` (service) → 500.
 *
 * Streaming: `stream.pipe(res)` lets Nest/Express pipe the readable
 * straight to the socket. We do NOT call `res.send` with a buffered
 * PDF — the spec mandates streaming (≤50 line items within 2s).
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { PdfGenerationService } from './pdf-generation.service';
import { QuotationsService } from '../quotations/application/quotations.service';
import { QuotationNotFoundError } from '../quotations/domain/quotation.errors';

/**
 * WU4 — endpoints.
 *
 * Sale: `GET /sales/:id/pdf?format={receipt-a4|receipt-ticket}`
 * Quotation: `GET /quotations/:id/pdf?format=quotation-a4`
 *
 * The path is nested under `sales` / `quotations` (not
 * `pdf-generation`) because each PDF is conceptually a derived view
 * of its parent record — the FE already navigates
 * `/sales/:id/...` and `/quotations/:id/...` for the detail flows.
 */
@Controller()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PdfGenerationController {
  constructor(
    private readonly pdfService: PdfGenerationService,
    // WU4 — the quotation preview route fetches the quotation via the
    // service so the tenant-scoping + 404 path is identical to the
    // `GET /quotations/:id` route. The PDF service then takes the wire
    // DTO and renders it — no back-coupling between modules.
    private readonly quotationsService: QuotationsService,
  ) {}

  @Get('sales/:id/pdf')
  @RequirePermissions(['read', 'Sale'])
  async generateSalePdf(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const resolvedFormat = this.pdfService.resolveFormat(format);

    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new Error('TENANT_CONTEXT_REQUIRED');
    }

    const { stream, folio } = await this.pdfService.generateSalePdf(
      id,
      tenantId,
      resolvedFormat,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': this.buildReceiptContentDisposition(folio),
    });
    stream.pipe(res);
  }

  @Get('quotations/:id/pdf')
  @RequirePermissions(['read', 'Quotation'])
  async generateQuotationPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('format') format: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const resolvedFormat = this.pdfService.resolveFormat(format);

    // Tenant isolation is enforced inside `QuotationsService.findOne`
    // — the controller only needs to translate the domain
    // `QuotationNotFoundError` to the HTTP `NotFoundException`. The
    // current tenant is the JWT-derived context; the service fetches
    // through the tenant-scoped Prisma client.
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new Error('TENANT_CONTEXT_REQUIRED');
    }

    let quotation;
    try {
      quotation = await this.quotationsService.findOne(id);
    } catch (err) {
      if (err instanceof QuotationNotFoundError) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }

    const { stream, folio } = await this.pdfService.renderQuotationPdf(
      quotation,
      resolvedFormat,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': this.buildQuotationContentDisposition(folio),
    });
    stream.pipe(res);
  }

  /**
   * Sale receipt filename. `attachment; filename="recibo-{folio}.pdf"`.
   * Sanitized to a safe filename charset because some folios can
   * contain `/` or other path-unsafe characters.
   */
  private buildReceiptContentDisposition(folio: string): string {
    const safeFolio = folio.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    return `attachment; filename="recibo-${safeFolio}.pdf"`;
  }

  /**
   * Quotation PDF filename. `inline; filename="cotizacion-{id}.pdf"`.
   * Same charset sanitization as the sale receipt. Inline (not
   * attachment) so the browser's built-in PDF viewer takes over when
   * a sales rep clicks "preview" on a draft — the spec's "PDF preview
   * for DRAFT/SENT/EXPIRED" scenario.
   */
  private buildQuotationContentDisposition(folio: string): string {
    const safeFolio = folio.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    return `inline; filename="cotizacion-${safeFolio}.pdf"`;
  }
}
