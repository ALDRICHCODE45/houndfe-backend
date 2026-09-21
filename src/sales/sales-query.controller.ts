import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { SalesService } from './sales.service';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { ListPendingRefundsQueryDto } from './dto/list-pending-refunds-query.dto';
import { SettleRefundDto } from './dto/settle-refund.dto';
import { UpdateSaleDueDateDto } from './dto/update-sale-due-date.dto';
import { AssignSellerDto } from './dto/assign-seller.dto';
import { CancelSaleDto } from './dto/cancel-sale.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesQueryController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  @RequirePermissions(['read', 'Sale'])
  list(@Query() query: ListSalesQueryDto) {
    query.resolveLegacyAlias();
    return this.salesService.listSales(query);
  }

  /**
   * GET /sales/refunds/pending — pending refund obligations (prf-3).
   *
   * Declared BEFORE the `:id` route below: Nest matches routes in
   * declaration order, and a parameterized route must never get the
   * chance to read `refunds` as a sale id.
   */
  @Get('refunds/pending')
  @RequirePermissions(['read', 'SaleRefund'])
  listPendingRefunds(@Query() query: ListPendingRefundsQueryDto) {
    return this.salesService.listPendingRefunds(query);
  }

  /**
   * POST /sales/refunds/:refundId/settlements — rfs-3b settlement entry point.
   *
   * Declared BEFORE the parameterized `:id` sale routes: Nest matches in
   * declaration order and `refunds` must never be read as a sale id. The
   * idempotency key is normalized here (trimmed; blank rejected) so an
   * equivalent retry replays the stored settlement instead of appending a
   * second one, while the service-owned request hash keeps the key
   * actor-scoped. Domain failures surface through DomainExceptionFilter:
   * REFUND_NOT_FOUND → 404, IDEMPOTENCY_KEY_CONFLICT / REFUND_ALREADY_SETTLED
   * → 409, SETTLEMENT_EXCEEDS_REFUND → 422.
   */
  @Post('refunds/:refundId/settlements')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'SaleRefund'])
  settleRefund(
    @Param('refundId', new ParseUUIDPipe()) refundId: string,
    @Body() dto: SettleRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();

    if (!normalizedIdempotencyKey) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }

    return this.salesService.settleRefund(
      refundId,
      user.userId,
      dto,
      normalizedIdempotencyKey,
    );
  }

  @Get(':id')
  @RequirePermissions(['read', 'Sale'])
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.salesService.getSaleDetail(id);
  }

  @Patch(':id/due-date')
  @RequirePermissions(['update', 'Sale'])
  setDueDate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSaleDueDateDto,
  ) {
    return this.salesService.setDueDate(id, dto);
  }

  @Put(':id/seller')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Sale'])
  assignSeller(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignSellerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.assignSeller(id, user.userId, dto);
  }

  @Delete(':id/seller')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'Sale'])
  async clearSeller(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.salesService.clearSeller(id, user.userId);
  }

  /**
   * POST /sales/:id/cancel — Cancel a confirmed sale (admin).
   * Requires `delete:Sale` permission. Maps domain errors via DomainExceptionFilter:
   *   SALE_NOT_CANCELLABLE / SALE_DELIVERED_CANNOT_CANCEL → 409 Conflict
   *   SALE_NOT_FOUND → 404 Not Found
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['delete', 'Sale'])
  cancelSale(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.cancelSale(id, user.userId, dto);
  }
}
