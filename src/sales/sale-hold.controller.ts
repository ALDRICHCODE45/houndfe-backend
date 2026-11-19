import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ExpireSaleHoldDto } from './dto/expire-sale-hold.dto';
import { SaleHoldExpireService } from './sale-hold-expire.service';

/**
 * pay-in-store-pickup / T1 (S5) — staff edit of a pay-in-store hold.
 *
 * PATCH /sales/:id/hold `{ expiresAt, expectedVersion }` → the sale detail
 * (same shape as GET /sales/:id, `hold` included). Same permission as every
 * other confirmed-sale edit (`update:Sale`, e.g. PATCH /sales/:id/due-date).
 * Errors (code-only body): 404 SALE_NOT_FOUND, 409 SALE_NOT_PAY_IN_STORE /
 * SALE_HOLD_NOT_EDITABLE / HOLD_VERSION_CONFLICT, 422 HOLD_EXPIRY_NOT_FUTURE.
 *
 * T6 (S11) — POST /sales/:id/hold/expire `{ expectedVersion }` with an
 * `Idempotency-Key` header: «Vencer apartado ahora», the hold sweep's expiry
 * decision applied now. → the sale detail plus `outcome` (`CANCELLED`,
 * `REVIEW`, `SETTLED`). Errors: 400 IDEMPOTENCY_KEY_REQUIRED / validation,
 * 404 SALE_NOT_FOUND, 409 SALE_NOT_PAY_IN_STORE / HOLD_ALREADY_CLOSED /
 * SALE_HOLD_NOT_EDITABLE / HOLD_VERSION_CONFLICT / IDEMPOTENCY_KEY_CONFLICT /
 * IDEMPOTENCY_KEY_IN_FLIGHT.
 */
@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SaleHoldController {
  constructor(
    private readonly holds: SaleHoldService,
    private readonly salesService: SalesService,
    private readonly expiry: SaleHoldExpireService,
  ) {}

  @Post(':id/hold/expire')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Sale'])
  expireHold(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ExpireSaleHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    return this.expiry.expireNow(
      id,
      user.userId,
      { expectedVersion: dto.expectedVersion },
      normalizedIdempotencyKey,
    );
  }

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
