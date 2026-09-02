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
 *   GET   /tenants/:tenantId/catalog-settings → read:TenantCatalogSettings
 *   PATCH /tenants/:tenantId/catalog-settings → update:TenantCatalogSettings
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
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { UpdateCatalogSettingsUseCase } from '../application/update-catalog-settings.use-case';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
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
    private readonly updateCatalogSettingsUseCase: UpdateCatalogSettingsUseCase,
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

  /**
   * PATCH mirrors the GET tenant-scope gate exactly (same non-oracle 404
   * before any use-case invocation, `manage:all` cross-tenant exception),
   * then delegates the validated body plus the authenticated actor's ID to
   * the update use case, which already returns the committed response DTO —
   * no domain/Prisma entity ever reaches the HTTP boundary. `no-store` is set
   * with Nest's direct `@Header` response-header metadata so an already-
   * committed settings write is never cached — no interceptor/provider
   * registration is required for the header to be wired at runtime.
   */
  @Patch()
  @RequirePermissions(['update', 'TenantCatalogSettings'])
  @Header('Cache-Control', 'no-store')
  async updateSettings(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() data: UpdateCatalogSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<CatalogSettingsResponseDto> {
    const crossTenantAllowed = req.ability?.can('manage', 'all') === true;
    if (user.tenantId !== tenantId && !crossTenantAllowed) {
      throw new NotFoundException(
        `Catalog settings not found for tenant ${tenantId}`,
      );
    }
    return this.updateCatalogSettingsUseCase.execute({
      tenantId,
      actorUserId: user.userId,
      data,
    });
  }
}
