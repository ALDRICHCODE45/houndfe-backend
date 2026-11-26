import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
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
import {
  PdfGenerationService,
  type CollectionReceiptFormat,
} from '../pdf-generation/pdf-generation.service';
import { CollectionReadService } from './collection-read.service';

const FORMATS: readonly CollectionReceiptFormat[] = ['ticket', 'a4'];

/**
 * customer-collection / T3 (S5) — `GET /collections/:collectionId/pdf?format=
 * ticket|a4`, permission `read:Sale` (contract v1 §1, §7; owner Q5 «Un
 * "Comprobante de cobro" general»).
 *
 * Lives in src/sales next to the read service but is REGISTERED in
 * PdfGenerationModule (the customer statement PDF pattern): that module
 * already imports SalesModule, so no module cycle.
 *
 * - `format` absent or empty → `ticket`; anything else than `ticket`/`a4` →
 *   `400 INVALID_FORMAT` (checked before any read, as `GET /sales/:id/pdf`).
 * - Unknown / foreign collection → `404 COLLECTION_NOT_FOUND`.
 * - Read and render happen before any response header; a render failure is
 *   `500 PDF_GENERATION_FAILED`.
 * - `Content-Disposition: attachment` like the sale receipt route,
 *   `Cache-Control: no-store`.
 */
@Controller('collections/:collectionId/pdf')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CollectionReceiptPdfController {
  constructor(
    private readonly collections: CollectionReadService,
    private readonly pdfGenerationService: PdfGenerationService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Sale'])
  @Header('Cache-Control', 'no-store')
  async receiptPdf(
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
    @Query('format') format: unknown,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const resolved = resolveCollectionReceiptFormat(format);
    const receipt = await this.collections.getReceipt(collectionId);
    const pdf = await this.pdfGenerationService.renderCollectionReceiptPdf(
      receipt,
      resolved,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${buildCollectionReceiptPdfFilename(
        collectionId,
      )}"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  }
}

export function resolveCollectionReceiptFormat(
  format: unknown,
): CollectionReceiptFormat {
  if (format === undefined || format === '') return 'ticket';
  if (
    typeof format !== 'string' ||
    !FORMATS.includes(format as CollectionReceiptFormat)
  ) {
    throw new BadRequestException('INVALID_FORMAT');
  }
  return format as CollectionReceiptFormat;
}

/** Fixed, user-data-free filename; the id is re-sanitized here. */
export function buildCollectionReceiptPdfFilename(collectionId: string): string {
  return `comprobante-cobro-${collectionId.replace(/[^a-zA-Z0-9-]/g, '')}.pdf`;
}
