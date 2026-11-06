/**
 * shipping-zones / T2 (S5) — sucursal shipping settings.
 *
 *   GET    /tenants/:tenantId/shipping-boxes          read:ShippingSettings
 *   POST   /tenants/:tenantId/shipping-boxes          update:ShippingSettings
 *   PATCH  /tenants/:tenantId/shipping-boxes/:boxId   update:ShippingSettings
 *   DELETE /tenants/:tenantId/shipping-boxes/:boxId   update:ShippingSettings
 *   GET    /tenants/:tenantId/shipping-origin         read:ShippingSettings
 *   PUT    /tenants/:tenantId/shipping-origin         update:ShippingSettings
 *
 * Tenant scope mirrors `CatalogSettingsController`: a JWT/path tenant
 * mismatch is a non-oracle 404 before any service call, unless the request
 * ability allows `manage:all`.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ShippingSettingsService } from '../application/shipping-settings.service';
import {
  CreateShippingBoxDto,
  PutShippingOriginDto,
  UpdateShippingBoxDto,
} from '../dto/shipping-settings.dto';

type RequestWithAbility = Request & { ability?: AppAbility };

@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class ShippingSettingsController {
  constructor(private readonly settings: ShippingSettingsService) {}

  @Get('shipping-boxes')
  @RequirePermissions(['read', 'ShippingSettings'])
  listBoxes(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.listBoxes(tenantId);
  }

  @Post('shipping-boxes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'ShippingSettings'])
  createBox(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: CreateShippingBoxDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.createBox(tenantId, dto);
  }

  @Patch('shipping-boxes/:boxId')
  @RequirePermissions(['update', 'ShippingSettings'])
  updateBox(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('boxId', new ParseUUIDPipe()) boxId: string,
    @Body() dto: UpdateShippingBoxDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.updateBox(tenantId, boxId, dto);
  }

  @Delete('shipping-boxes/:boxId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'ShippingSettings'])
  deleteBox(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('boxId', new ParseUUIDPipe()) boxId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.deleteBox(tenantId, boxId);
  }

  @Get('shipping-origin')
  @RequirePermissions(['read', 'ShippingSettings'])
  getOrigin(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.getOrigin(tenantId);
  }

  @Put('shipping-origin')
  @RequirePermissions(['update', 'ShippingSettings'])
  @Header('Cache-Control', 'no-store')
  putOrigin(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: PutShippingOriginDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ) {
    this.admitTenant(tenantId, user, req);
    return this.settings.putOrigin(tenantId, user.userId, dto);
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
        `Shipping settings not found for tenant ${tenantId}`,
      );
    }
  }
}
