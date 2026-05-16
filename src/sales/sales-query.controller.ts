import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { SalesService } from './sales.service';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { UpdateSaleDueDateDto } from './dto/update-sale-due-date.dto';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesQueryController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  @RequirePermissions(['read', 'Sale'])
  list(@Query() query: ListSalesQueryDto) {
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
}
