import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { ConfirmReceiptDto } from './dto/confirm-receipt.dto';
import { RejectReceiptDto } from './dto/reject-receipt.dto';
import { ReceiptReviewService } from './receipt-review.service';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class ReceiptReviewController {
  constructor(private readonly receiptReviewService: ReceiptReviewService) {}

  @Get(':id/receipts')
  @RequirePermissions(['read', 'ReceiptEvidence'])
  listPending(@Param('id', new ParseUUIDPipe()) saleId: string) {
    return this.receiptReviewService.listPending(saleId);
  }

  @Post(':id/receipts/:receiptId/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'ReceiptEvidence'])
  confirm(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('receiptId', new ParseUUIDPipe()) receiptId: string,
    @Body() dto: ConfirmReceiptDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();

    if (!normalizedIdempotencyKey) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }

    return this.receiptReviewService.confirm(
      saleId,
      receiptId,
      user.userId,
      dto,
      normalizedIdempotencyKey,
    );
  }

  @Post(':id/receipts/:receiptId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'ReceiptEvidence'])
  async reject(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('receiptId', new ParseUUIDPipe()) receiptId: string,
    @Body() dto: RejectReceiptDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.receiptReviewService.reject(saleId, receiptId, user.userId, dto);
  }
}
