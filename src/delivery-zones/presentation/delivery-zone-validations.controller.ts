/**
 * shipping-zones / T1 (S2, S3) — store zone-validation routes.
 *
 *   GET  /delivery-zone-validations              validate:DeliveryZone
 *        PENDING validations, oldest pending requester message first, with
 *        requesterCount and the 24 h urgency block.
 *   GET  /delivery-zone-validations/:id          validate:DeliveryZone
 *   POST /delivery-zone-validations/:id/resolve  validate:DeliveryZone
 *        APPROVE_DELIVERY_ZONE | REJECT_DELIVERY_ZONE; returns the
 *        validation and the zone it created/updated (200 on first resolve
 *        and on an exact replay).
 *
 * `manage:DeliveryZone` and `manage:all` also pass (CASL `manage` wildcard).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { parseDeliveryZoneResolveRequest } from '../domain/delivery-zone-resolve.request';
import {
  APPROVE_DELIVERY_ZONE,
  DELIVERY_ZONE_VALIDATION_REPOSITORY,
  type IDeliveryZoneValidationRepository,
  type ResolveDeliveryZoneValidationCommand,
} from '../domain/delivery-zone-validation.repository';
import { DeliveryZoneHttpFilter } from './delivery-zone-http.filter';
import { requireTenantActor } from './delivery-zones.controller';
import {
  toDeliveryZoneResponse,
  type DeliveryZoneResponse,
} from './dto/delivery-zone.dto';
import {
  ListDeliveryZoneValidationsQueryDto,
  toDeliveryZoneValidationResponse,
  type DeliveryZoneValidationResponse,
} from './dto/delivery-zone-validation.dto';

type RequestWithUser = Request & { user?: AuthenticatedUser };

export interface DeliveryZoneValidationListResponse {
  data: DeliveryZoneValidationResponse[];
  pagination: {
    pageIndex: number;
    pageSize: number;
    totalCount: number;
    pageCount: number;
  };
}

export interface ResolveDeliveryZoneValidationResponse {
  validation: DeliveryZoneValidationResponse;
  zone: DeliveryZoneResponse;
}

const DEFAULT_PAGE_SIZE = 20;

@Controller('delivery-zone-validations')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
@UseFilters(DeliveryZoneHttpFilter)
export class DeliveryZoneValidationsController {
  constructor(
    @Inject(DELIVERY_ZONE_VALIDATION_REPOSITORY)
    private readonly validations: IDeliveryZoneValidationRepository,
  ) {}

  @Get()
  @RequirePermissions(['validate', 'DeliveryZone'])
  async listPending(
    @Query() query: ListDeliveryZoneValidationsQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneValidationListResponse> {
    requireTenantActor(request);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const result = await this.validations.listPending({ page, limit });
    const now = new Date();
    return {
      data: result.items.map((item) =>
        toDeliveryZoneValidationResponse(item, now),
      ),
      pagination: {
        pageIndex: page - 1,
        pageSize: limit,
        totalCount: result.totalCount,
        pageCount: Math.ceil(result.totalCount / limit),
      },
    };
  }

  @Get(':id')
  @RequirePermissions(['validate', 'DeliveryZone'])
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: RequestWithUser,
  ): Promise<DeliveryZoneValidationResponse> {
    requireTenantActor(request);
    const record = await this.validations.findById(id);
    if (record === null) {
      throw new NotFoundException('Delivery zone validation not found');
    }
    return toDeliveryZoneValidationResponse(record, new Date());
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['validate', 'DeliveryZone'])
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() raw: unknown,
    @Req() request: RequestWithUser,
  ): Promise<ResolveDeliveryZoneValidationResponse> {
    const user = requireTenantActor(request);
    const parsed = parseDeliveryZoneResolveRequest(raw);
    const base = {
      validationId: id,
      expectedVersion: parsed.expectedVersion,
      resolutionRequestId: parsed.resolutionRequestId,
      actorUserId: user.userId,
      actorIsSuperAdmin: user.isSuperAdmin === true,
    };
    const command: ResolveDeliveryZoneValidationCommand =
      parsed.action === APPROVE_DELIVERY_ZONE
        ? { ...base, action: parsed.action, settings: parsed.settings }
        : { ...base, action: parsed.action };
    const result = await this.validations.resolve(command);
    return {
      validation: toDeliveryZoneValidationResponse(
        result.validation,
        new Date(),
      ),
      zone: toDeliveryZoneResponse(result.zone),
    };
  }
}
