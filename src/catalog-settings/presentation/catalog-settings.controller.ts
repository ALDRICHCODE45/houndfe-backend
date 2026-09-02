/**
 * HTTP CONTROLLER: CatalogSettingsController — online-catalog-publishing /
 * WU3A3b.
 *
 * Thin adapter for the `catalog-settings` bounded context. Mirrors the
 * `DeliveryRoutesController` / `AdminPaymentMethodController` patterns:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` at the
 *     class level.
 *   - `@RequirePermissions([action, 'TenantCatalogSettings'])` per route.
 *   - No service layer: the GET handler calls the application use case
 *     (`executeWithCoverage`) and maps its result with the committed response
 *     mapper (`toCatalogSettingsResponseDto`).
 *
 * Routes (canonical literal path — the `/admin/...` wording in the OpenSpec
 * design snapshot is superseded):
 *   GET /tenants/:tenantId/catalog-settings → read:TenantCatalogSettings
 *
 * Tenant scoping (design §5.3, ADR-5):
 *   - Ordinary users may only read their own JWT tenant's settings. A JWT/path
 *     tenant mismatch is denied BEFORE any use-case invocation and surfaced as
 *     not found so the route is not a tenant-existence oracle.
 *   - Cross-tenant reads are permitted only when the request CASL ability
 *     (attached by `PermissionsGuard`) allows `manage:all`. No role names are
 *     inferred here.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { GetCatalogSettingsUseCase } from '../application/get-catalog-settings.use-case';
import {
  toCatalogSettingsResponseDto,
  type CatalogSettingsResponseDto,
} from '../dto/catalog-settings-response.dto';

/**
 * Request augmentation: `PermissionsGuard` attaches the built CASL ability
 * to the request as `ability` for per-request authorization decisions. The
 * Express `Request` shape is widened inline, matching the delivery-routes
 * controller, without forcing a global type augmentation.
 */
type RequestWithAbility = Request & {
  ability?: AppAbility;
};

@Controller('tenants/:tenantId/catalog-settings')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CatalogSettingsController {
  constructor(
    private readonly getCatalogSettingsUseCase: GetCatalogSettingsUseCase,
  ) {}

  @Get()
  @RequirePermissions(['read', 'TenantCatalogSettings'])
  async getSettings(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<CatalogSettingsResponseDto> {
    // Tenant scope gate — deny BEFORE any use-case invocation. A missing
    // `request.ability` (PermissionsGuard not wired) fails closed: deny-by-
    // default, never role-name inference. The message mirrors the use case's
    // `CatalogSettingsNotFoundError` text so a mismatched caller cannot
    // distinguish "foreign tenant" from "no settings".
    const crossTenantAllowed = req.ability?.can('manage', 'all') === true;
    if (user.tenantId !== tenantId && !crossTenantAllowed) {
      throw new NotFoundException(
        `Catalog settings not found for tenant ${tenantId}`,
      );
    }
    const { settings, defaultContextProductCount } =
      await this.getCatalogSettingsUseCase.executeWithCoverage({ tenantId });
    return toCatalogSettingsResponseDto(settings, {
      defaultContextProductCount,
    });
  }
}
