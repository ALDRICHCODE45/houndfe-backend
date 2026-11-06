/**
 * shipping-zones / T1 (S1) — store delivery-zone routes.
 *
 *   GET    /delivery-zones            read:DeliveryZone    list/search
 *   GET    /delivery-zones/:zipCode   read:DeliveryZone    one zone (active or not)
 *   PUT    /delivery-zones/:zipCode   manage:DeliveryZone  create/replace + activate
 *   DELETE /delivery-zones/:zipCode   manage:DeliveryZone  deactivate (soft)
 *
 * Guards follow the human-decision reviewer controller: JWT -> CLS tenant ->
 * CASL. The actor is read only from the verified `request.user`.
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { normalizeZoneSettings } from '../domain/delivery-zone.policy';
import {
  DELIVERY_ZONE_REPOSITORY,
  type IDeliveryZoneRepository,
} from '../domain/delivery-zone.repository';
import { DeliveryZoneHttpFilter } from './delivery-zone-http.filter';
import {
  ListDeliveryZonesQueryDto,
  toDeliveryZoneResponse,
  UpsertDeliveryZoneDto,
  type DeliveryZoneResponse,
} from './dto/delivery-zone.dto';
import { ParseZipCodePipe } from './zip-code.pipe';

type RequestWithUser = Request & { user?: AuthenticatedUser };

export interface DeliveryZoneListResponse {
  data: DeliveryZoneResponse[];
  pagination: {
    pageIndex: number;
    pageSize: number;
    totalCount: number;
    pageCount: number;
  };
}

const DEFAULT_PAGE_SIZE = 20;

/** Verified principal with a tenant; a tenantless superadmin gets a 403. */
export function requireTenantActor(
  request: RequestWithUser,
): AuthenticatedUser {
  const user = request.user;
  if (!user || typeof user.userId !== 'string' || user.userId.length === 0) {
    throw new UnauthorizedException('Authenticated user required');
  }
  if (typeof user.tenantId !== 'string' || user.tenantId.length === 0) {
    throw new ForbiddenException('Tenant context required');
  }
  return user;
}

@Controller('delivery-zones')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
@UseFilters(DeliveryZoneHttpFilter)
export class DeliveryZonesController {
  constructor(
    @Inject(DELIVERY_ZONE_REPOSITORY)
    private readonly zones: IDeliveryZoneRepository,
  ) {}

  @Get()
  @RequirePermissions(['read', 'DeliveryZone'])
  async list(
    @Query() query: ListDeliveryZonesQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneListResponse> {
    requireTenantActor(request);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const result = await this.zones.list({
      page,
      limit,
      search: query.search || undefined,
      type: query.type,
      isActive:
        query.active === undefined ? undefined : query.active === 'true',
    });
    return {
      data: result.items.map(toDeliveryZoneResponse),
      pagination: {
        pageIndex: page - 1,
        pageSize: limit,
        totalCount: result.totalCount,
        pageCount: Math.ceil(result.totalCount / limit),
      },
    };
  }

  @Get(':zipCode')
  @RequirePermissions(['read', 'DeliveryZone'])
  async findOne(
    @Param('zipCode', ParseZipCodePipe) zipCode: string,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneResponse> {
    requireTenantActor(request);
    const zone = await this.zones.findByZipCode(zipCode);
    if (zone === null) {
      throw new NotFoundException('Delivery zone not found');
    }
    return toDeliveryZoneResponse(zone);
  }

  @Put(':zipCode')
  @RequirePermissions(['manage', 'DeliveryZone'])
  async upsert(
    @Param('zipCode', ParseZipCodePipe) zipCode: string,
    @Body() body: UpsertDeliveryZoneDto,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneResponse> {
    const user = requireTenantActor(request);
    const settings = normalizeZoneSettings({
      type: body.type,
      surchargeCents: body.surchargeCents,
      etaDays: body.etaDays,
    });
    const zone = await this.zones.upsert({
      zipCode,
      settings,
      state: body.state ?? null,
      municipality: body.municipality ?? null,
      neighborhood: body.neighborhood ?? null,
      actorUserId: user.userId,
      actorIsSuperAdmin: user.isSuperAdmin === true,
    });
    return toDeliveryZoneResponse(zone);
  }

  @Delete(':zipCode')
  @RequirePermissions(['manage', 'DeliveryZone'])
  async deactivate(
    @Param('zipCode', ParseZipCodePipe) zipCode: string,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneResponse> {
    requireTenantActor(request);
    return toDeliveryZoneResponse(await this.zones.deactivate(zipCode));
  }
}
