/**
 * PdfGenerationController — HTTP adapter for `GET /sales/:id/pdf`.
 *
 * The `GET /quotations/:id/pdf` route was moved to `QuotationsController`
 * (WU4) to avoid a circular DI dependency between `PdfGenerationModule`
 * and `QuotationsModule`.
 */
import {
  Controller,
  Get,
  Param,
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

@Controller()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PdfGenerationController {
  constructor(private readonly pdfService: PdfGenerationService) {}

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

  private buildReceiptContentDisposition(folio: string): string {
    const safeFolio = folio.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    return `attachment; filename="recibo-${safeFolio}.pdf"`;
  }
}
