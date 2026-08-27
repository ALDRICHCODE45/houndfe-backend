/**
 * HTTP CONTROLLER: DeliveryRoutesController — delivery-routes / WU2.
 *
 * Thin adapter for the bounded context. Mirrors the
 * `AdminPaymentDetailController` / `QuotationsController` patterns:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` at the
 *     class level.
 *   - `@RequirePermissions([action, 'DeliveryRoute'])` per route.
 *   - No admin/driver branching — ownership decisions live in the CASL
 *     ability + the `request.ability` filter the service uses (design
 *     ADR-5).
 *
 * Routes (design §8.1):
 *   POST   /delivery-routes                            → create:DeliveryRoute
 *   GET    /delivery-routes                            → read:DeliveryRoute
 *   GET    /delivery-routes/:id                        → read:DeliveryRoute
 *   PATCH  /delivery-routes/:id                        → update:DeliveryRoute
 *   DELETE /delivery-routes/:id                        → delete:DeliveryRoute
 *   POST   /delivery-routes/:id/start                  → update:DeliveryRoute
 *   POST   /delivery-routes/:id/cancel                 → update:DeliveryRoute
 *   POST   /delivery-routes/:id/stops                  → update:DeliveryRoute
 *   POST   /delivery-routes/:id/stops/:stopId/check-in → update:DeliveryRoute
 *   PUT    /delivery-routes/:id/stops/reorder          → update:DeliveryRoute
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
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
import { DeliveryRoutesService, type DeliveryRouteRequestContext } from '../application/delivery-routes.service';
import { CreateDeliveryRouteDto } from '../dto/create-delivery-route.dto';
import { AddStopDto } from '../dto/add-stop.dto';
import { ReorderStopsDto } from '../dto/reorder-stops.dto';
import { UpdateDeliveryRouteDto } from '../dto/update-delivery-route.dto';
import { ListDeliveryRoutesQueryDto } from '../dto/list-delivery-routes-query.dto';
import type { DeliveryRouteResponseDto } from '../dto/delivery-route-response.dto';

/**
 * Request augmentation: `PermissionsGuard` (modified in WU2 — 2.18)
 * attaches the built ability to the request as `ability` for the
 * service layer to consume. The Express `Request` shape is widened
 * inline to keep the controller self-contained without forcing a
 * global type augmentation.
 */
type RequestWithAbility = Request & {
  ability?: AppAbility;
};

@Controller('delivery-routes')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class DeliveryRoutesController {
  constructor(
    private readonly deliveryRoutesService: DeliveryRoutesService,
  ) {}

  /**
   * Build the per-request context the service consumes. Centralizes the
   * `ability` extraction so every handler stays a one-liner.
   */
  private context(
    user: AuthenticatedUser,
    req: RequestWithAbility,
  ): DeliveryRouteRequestContext {
    if (!req.ability) {
      throw new Error(
        'PermissionsGuard must attach request.ability (delivery-routes / WU2 wiring).',
      );
    }
    return { userId: user.userId, ability: req.ability };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'DeliveryRoute'])
  create(
    @Body() dto: CreateDeliveryRouteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.create(this.context(user, req), dto);
  }

  @Get()
  @RequirePermissions(['read', 'DeliveryRoute'])
  list(
    @Query() query: ListDeliveryRoutesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto[]> {
    return this.deliveryRoutesService.list(this.context(user, req), query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'DeliveryRoute'])
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.getById(this.context(user, req), id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'DeliveryRoute'])
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDeliveryRouteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.update(this.context(user, req), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'DeliveryRoute'])
  delete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<void> {
    return this.deliveryRoutesService.delete(this.context(user, req), id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'DeliveryRoute'])
  start(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.start(this.context(user, req), id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'DeliveryRoute'])
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.cancel(this.context(user, req), id);
  }

  @Post(':id/stops')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'DeliveryRoute'])
  addStop(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddStopDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.addStop(this.context(user, req), id, dto);
  }

  @Post(':id/stops/:stopId/check-in')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'DeliveryRoute'])
  checkInStop(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('stopId', new ParseUUIDPipe()) stopId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.checkInStop(
      this.context(user, req),
      id,
      stopId,
    );
  }

  @Put(':id/stops/reorder')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'DeliveryRoute'])
  reorderStops(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReorderStopsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<DeliveryRouteResponseDto> {
    return this.deliveryRoutesService.reorderStops(
      this.context(user, req),
      id,
      dto,
    );
  }
}
