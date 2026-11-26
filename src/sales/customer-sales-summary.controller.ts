import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import {
  CustomerSalesSummaryService,
  type CustomerSalesSummaryResponse,
} from './customer-sales-summary.service';

/**
 * customers-listing T4 (S4, contract §6.2) — `GET /customers/:customerId/
 * sales-summary`, permission `read:Sale`: the customer page KPI strip with
 * the listing row metric rules (see `CustomerSalesSummaryService`).
 *
 * Lives in the sales module next to `sales-monthly` and `payments` (sales
 * money, read with raw SQL). Non-UUID id → 400; unknown or foreign-tenant
 * customer → `404 CUSTOMER_NOT_FOUND` (code-only).
 */
@Controller('customers/:customerId/sales-summary')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomerSalesSummaryController {
  constructor(private readonly summaries: CustomerSalesSummaryService) {}

  @Get()
  @RequirePermissions(['read', 'Sale'])
  summary(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<CustomerSalesSummaryResponse> {
    return this.summaries.summary(customerId);
  }
}
