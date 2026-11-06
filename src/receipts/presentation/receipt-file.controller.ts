import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import {
  ReceiptFileService,
  type ReceiptFileVariant,
} from '../application/receipt-file.service';
import { ReceiptReadExceptionFilter } from './receipt-read-exception.filter';

/**
 * Staff read path for private receipts: the original file and its preview
 * (the image itself, or the rasterized first PDF page). Same guards as the
 * review queue. Bytes are streamed through the backend, never from a public
 * or signed Spaces URL.
 */
@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
@UseFilters(ReceiptReadExceptionFilter)
export class ReceiptFileController {
  constructor(private readonly receiptFileService: ReceiptFileService) {}

  @Get(':id/receipts/:receiptId/file')
  @RequirePermissions(['read', 'ReceiptEvidence'])
  original(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('receiptId', new ParseUUIDPipe()) receiptId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.stream(saleId, receiptId, 'original', res);
  }

  @Get(':id/receipts/:receiptId/preview')
  @RequirePermissions(['read', 'ReceiptEvidence'])
  preview(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('receiptId', new ParseUUIDPipe()) receiptId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.stream(saleId, receiptId, 'preview', res);
  }

  private async stream(
    saleId: string,
    receiptId: string,
    variant: ReceiptFileVariant,
    res: Response,
  ): Promise<StreamableFile> {
    const file = await this.receiptFileService.open(saleId, receiptId, variant);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: `inline; filename="${file.filename}"`,
      ...(file.contentLength !== null ? { length: file.contentLength } : {}),
    });
  }
}
