import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { CustomersListingOptionsQueryDto } from './customers-listing-options-query.dto';
import { CustomersListingQueryDto } from './customers-listing-query.dto';
import { CustomersListingService } from './customers-listing.service';

type RequestWithAbility = Request & { ability?: AppAbility };

/**
 * customers-listing — `GET /customers/listing` (contract §3.1) and
 * `GET /customers/listing/options` (§5).
 *
 * A separate controller so `CustomersController`'s constructor (used by other
 * modules' test worlds) does not change. `CustomersModule` registers it
 * BEFORE `CustomersController`, so Express matches `listing` here instead of
 * routing it into `GET /customers/:id` (whose `ParseUUIDPipe` would answer
 * 400).
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomersListingController {
  constructor(private readonly listing: CustomersListingService) {}

  @Get('listing')
  @RequirePermissions(['read', 'Customer'])
  list(
    @Query() query: CustomersListingQueryDto,
    @Req() req: RequestWithAbility,
  ) {
    if (!req.ability) {
      throw new Error(
        'PermissionsGuard must attach request.ability (customers-listing wiring).',
      );
    }
    return this.listing.list(query, req.ability);
  }

  /** Contract §5 — selector values; `read:Customer` only (§10). */
  @Get('listing/options')
  @RequirePermissions(['read', 'Customer'])
  options(@Query() query: CustomersListingOptionsQueryDto) {
    return this.listing.options(query);
  }
}
