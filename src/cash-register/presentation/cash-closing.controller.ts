/**
 * HTTP CONTROLLER: cash-closing history (T3/S3,S7).
 *
 *   GET /cash-closings      → read:CashClosing query CLOSINGS
 *   GET /cash-closings/:id  → read:CashClosing query CLOSING
 *
 * Read-only: a closed cut is an immutable snapshot, so there is deliberately
 * no update/delete route. The service owns tenant filtering and the wider
 * `read:CashSessionAudit` projection; this adapter only forwards the query and
 * the trusted actor.
 */
import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import {
  CASH_APPLICATION,
  type CashDocument,
  type ICashApplication,
} from '../cash-application.port';
import { requireCashActor, type CashRequestWithAbility } from './cash-actor';
import { toCashPageInput } from './cash-query.mapper';
import { ListClosingsQueryDto } from './dto/query.dto';

@Controller('cash-closings')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashClosingController {
  constructor(
    @Inject(CASH_APPLICATION)
    private readonly application: ICashApplication,
  ) {}

  @Get()
  @RequirePermissions(['read', 'CashClosing'])
  listClosings(
    @Query() query: ListClosingsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'CLOSINGS',
      page: toCashPageInput(query),
    });
  }

  @Get(':id')
  @RequirePermissions(['read', 'CashClosing'])
  getClosing(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'CLOSING',
      id,
    });
  }
}
