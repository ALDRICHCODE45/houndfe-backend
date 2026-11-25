import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { SalesService } from './sales.service';
import {
  CustomerSalesMonthlyQueryDto,
  type CustomerSalesMonthlyResponseDto,
} from './dto/customer-sales-monthly.dto';

/**
 * sales-history-redesign S4 (contract §5.2) — the customer's monthly totals.
 *
 * Lives in the sales module (like `customers/:customerId/pets` lives in
 * customer-pets): the data is sales data read through `SalesService`, and a
 * route in `CustomersController` would make `CustomersModule` import
 * `SalesModule` and its whole dependency graph. Permission is `read:Sale`.
 * An unknown or foreign-tenant customer answers `404 CUSTOMER_NOT_FOUND`
 * with the code-only envelope of the customer pet routes.
 */
@Controller('customers/:customerId/sales-monthly')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesCustomerMonthlyController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  @RequirePermissions(['read', 'Sale'])
  monthly(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: CustomerSalesMonthlyQueryDto,
  ): Promise<CustomerSalesMonthlyResponseDto> {
    return this.salesService.getCustomerSalesMonthly(
      customerId,
      query.months ?? 12,
    );
  }
}
