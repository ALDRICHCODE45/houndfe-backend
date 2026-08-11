import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { SalesService } from './sales.service';
import { AddSalePaymentDto } from './dto/add-sale-payment.dto';
import { UpdateSalePaymentReferenceDto } from './dto/update-sale-payment-reference.dto';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesPaymentsController {
  constructor(private readonly salesService: SalesService) {}

  @Post(':id/payments')
  @RequirePermissions(['update', 'Sale'])
  addPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddSalePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();

    if (!normalizedIdempotencyKey) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }

    return this.salesService.addPayment(
      id,
      user.userId,
      dto,
      normalizedIdempotencyKey,
    );
  }

  @Patch(':saleId/payments/:paymentId/reference')
  @RequirePermissions(['update', 'Sale'])
  updatePaymentReference(
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: UpdateSalePaymentReferenceDto,
  ) {
    return this.salesService.updatePaymentReference(saleId, paymentId, dto);
  }
}
