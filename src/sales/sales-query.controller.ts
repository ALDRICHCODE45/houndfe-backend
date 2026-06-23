import {
  Body,
  Controller,
  Delete,
  Get,
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
