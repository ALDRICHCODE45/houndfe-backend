/**
 * quotation-sale-conversion / T1 — HTTP surface of the POS "Pedido" tab.
 *
 *   POST /quotations/from-sale/:saleId     POS DRAFT sale → DRAFT quotation
 *                                          (the draft sale is discarded)
 *   POST /quotations/:id/convert-to-sale   DRAFT/SENT quotation → POS DRAFT
 *                                          sale (quotation CONVERTED_TO_SALE)
 *
 * Both are write routes with side effects on two aggregates, so both require
 * the repository's `Idempotency-Key` header (same contract as
 * `POST /sales/drafts/:id/charge`: missing → 400 IDEMPOTENCY_KEY_REQUIRED).
 *
 * Permissions (CASL, AND semantics — every pair is required):
 *   - from-sale:       create:Quotation + delete:Sale  (the draft is deleted)
 *   - convert-to-sale: create:Sale + update:Quotation  (a sale is opened and
 *                                                      the quotation changes)
 *
 * A dedicated controller (same `quotations` prefix) keeps the existing
 * `QuotationsController` constructor and its specs untouched.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { QuotationSaleConversionService } from '../application/quotation-sale-conversion.service';
import { CreateQuotationFromSaleDto } from '../dto/create-quotation-from-sale.dto';

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) {
    throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
  }
  return key;
}

@Controller('quotations')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class QuotationSaleConversionController {
  constructor(private readonly conversion: QuotationSaleConversionService) {}

  @Post('from-sale/:saleId')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Quotation'], ['delete', 'Sale'])
  createFromSale(
    @Param('saleId', new ParseUUIDPipe()) saleId: string,
    @Body() dto: CreateQuotationFromSaleDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.conversion.createFromSaleDraft(
      saleId,
      user.userId,
      { customerNotes: dto.customerNotes ?? null },
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post(':id/convert-to-sale')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Sale'], ['update', 'Quotation'])
  convertToSale(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.conversion.convertToSale(
      id,
      user.userId,
      requireIdempotencyKey(idempotencyKey),
    );
  }
}
