import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { SalesService } from './sales.service';
import { SaleHoldService } from './sale-hold.service';
import { UpdateSaleHoldDto } from './dto/update-sale-hold.dto';

/**
 * pay-in-store-pickup / T1 (S5) — staff edit of a pay-in-store hold.
 *
 * PATCH /sales/:id/hold `{ expiresAt, expectedVersion }` → the sale detail
 * (same shape as GET /sales/:id, `hold` included). Same permission as every
 * other confirmed-sale edit (`update:Sale`, e.g. PATCH /sales/:id/due-date).
 * Errors (code-only body): 404 SALE_NOT_FOUND, 409 SALE_NOT_PAY_IN_STORE /
 * SALE_HOLD_NOT_EDITABLE / HOLD_VERSION_CONFLICT, 422 HOLD_EXPIRY_NOT_FUTURE.
 */
@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SaleHoldController {
  constructor(
    private readonly holds: SaleHoldService,
    private readonly salesService: SalesService,
  ) {}

  @Patch(':id/hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Sale'])
  async updateHold(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSaleHoldDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.holds.updateHold(id, user.userId, {
      expiresAt: new Date(dto.expiresAt),
      expectedVersion: dto.expectedVersion,
    });
    return this.salesService.getSaleDetail(id);
  }
}
