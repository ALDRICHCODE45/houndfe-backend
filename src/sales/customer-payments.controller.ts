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
import { CustomerPaymentsService } from './customer-payments.service';
import {
  CustomerPaymentsQueryDto,
  type CustomerPaymentsResponseDto,
} from './dto/customer-payments.dto';

/**
 * customers-listing T2 (S5, contract §7) — `GET /customers/:customerId/
 * payments?page=&limit=`, permission `read:Sale`: the customer's «Cobros y
 * recibos» feed (see `CustomerPaymentsService`).
 *
 * Lives in the sales module next to the customer collection and monthly
 * routes (sales money, read with raw SQL). Non-UUID id → 400; unknown or
 * foreign-tenant customer → `404 CUSTOMER_NOT_FOUND` (code-only).
 */
@Controller('customers/:customerId/payments')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomerPaymentsController {
  constructor(private readonly payments: CustomerPaymentsService) {}

  @Get()
  @RequirePermissions(['read', 'Sale'])
  list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: CustomerPaymentsQueryDto,
  ): Promise<CustomerPaymentsResponseDto> {
    return this.payments.list(customerId, {
      page: query.page,
      limit: query.limit,
    });
  }
}
