/**
 * shipping-zones / T7 (S10) — sucursal opening hours (store settings).
 *
 *   GET /tenants/:tenantId/opening-hours   read:ShippingSettings
 *   PUT /tenants/:tenantId/opening-hours   update:ShippingSettings
 *
 * Tenant scope mirrors `ShippingSettingsController`: a JWT/path tenant
 * mismatch is a non-oracle 404 before any service call, unless the request
 * ability allows `manage:all`.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../../auth/authorization/guards/permissions.guard';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../../shared/tenant/tenant-context.guard';
import { OpeningHoursService } from '../application/opening-hours.service';
import { PutOpeningHoursDto } from '../dto/opening-hours.dto';

type RequestWithAbility = Request & { ability?: AppAbility };

@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class OpeningHoursController {
  constructor(private readonly hours: OpeningHoursService) {}

  @Get('opening-hours')
  @RequirePermissions(['read', 'ShippingSettings'])
  get(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.hours.get(tenantId);
  }

  @Put('opening-hours')
  @RequirePermissions(['update', 'ShippingSettings'])
  @Header('Cache-Control', 'no-store')
  put(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: PutOpeningHoursDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.hours.put(tenantId, user.userId, dto);
  }

  /** Non-oracle 404 for a foreign tenant path; `manage:all` may cross. */
  private admitTenant(
    tenantId: string,
    user: AuthenticatedUser,
    req: RequestWithAbility,
  ): void {
    const crossTenantAllowed = req.ability?.can('manage', 'all') === true;
    if (user.tenantId !== tenantId && !crossTenantAllowed) {
      throw new NotFoundException(
        `Opening hours not found for tenant ${tenantId}`,
      );
    }
  }
}
