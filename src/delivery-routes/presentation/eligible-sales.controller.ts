/**
 * HTTP CONTROLLER: EligibleSalesController — delivery-routes / T4
 * (eligible-sales selector).
 *
 * Thin adapter over `EligibleSalesService`, mirroring
 * `DeliveryRoutesController`:
 *   - class-level `JwtAuthGuard` + `TenantContextGuard` + `PermissionsGuard`
 *   - `@RequirePermissions(['read', 'Sale'], ['create', 'DeliveryRoute'])`:
 *     the caller must be able to read sales AND be a route manager
 *
 * ROUTE ORDERING (parent wiring — IMPORTANT):
 * NestJS registers routes per controller in the `controllers` array order.
 * `GET /delivery-routes/:id` (in `DeliveryRoutesController`) would match
 * `eligible-sales` and fail `ParseUUIDPipe`. Register this controller
 * BEFORE `DeliveryRoutesController` in the module `controllers` array.
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import {
  EligibleSalesService,
  type EligibleSalesRequestContext,
} from '../application/eligible-sales.service';
import { EligibleSalesQueryDto } from '../dto/eligible-sales-query.dto';
import type { EligibleSalesResponseDto } from '../dto/eligible-sales-response.dto';

type RequestWithAbility = Request & { ability?: AppAbility };

@Controller('delivery-routes')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EligibleSalesController {
  constructor(private readonly eligibleSalesService: EligibleSalesService) {}

  private context(
    user: AuthenticatedUser,
    req: RequestWithAbility,
  ): EligibleSalesRequestContext {
    if (!req.ability) {
      throw new Error(
        'PermissionsGuard must attach request.ability (eligible-sales / T4 wiring).',
      );
    }
    return { userId: user.userId, ability: req.ability };
  }

  @Get('eligible-sales')
  @RequirePermissions(['read', 'Sale'], ['create', 'DeliveryRoute'])
  list(
    @Query() query: EligibleSalesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithAbility,
  ): Promise<EligibleSalesResponseDto> {
    return this.eligibleSalesService.list(this.context(user, req), query);
  }
}
